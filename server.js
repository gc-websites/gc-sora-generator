import express from 'express'
import cors from 'cors'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fetch from 'node-fetch'
import fs from 'fs/promises'
import dotenv from 'dotenv'

dotenv.config()
puppeteer.use(StealthPlugin())

const app = express()
const PORT = process.env.PORT || 4000

const STRAPI_API_URL = process.env.STRAPI_API_URL
const STRAPI_TOKEN = process.env.STRAPI_TOKEN
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

const corsOptions = {
	origin: ['https://nice-advice.info', 'https://www.nice-advice.info'],
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}

app.use(cors(corsOptions))
app.use(express.json())

function genId() {
	return Math.random().toString(36).slice(2, 16)
}

async function loadCookies(page) {
	const cookies = JSON.parse(await fs.readFile('./cookies.json', 'utf-8'))
	await page.setCookie(...cookies)
}

async function wait(ms) {
	return new Promise(res => setTimeout(res, ms))
}

async function isTextareaEmpty(page) {
	return await page.$eval(
		'textarea[placeholder="Describe your image..."]',
		el => !el.value
	)
}

async function waitForTaskIdByHash(page, hash_id, timeout = 60000) {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		await page.goto('https://sora.chatgpt.com/library', {
			waitUntil: 'networkidle2',
		})

		const task_id = await page.$$eval(
			'div.flex.flex-col.gap-1',
			(cards, hash) => {
				for (let card of cards) {
					const promptDiv = Array.from(card.querySelectorAll('div')).find(
						d => d.textContent && d.textContent.includes(hash)
					)
					if (promptDiv) {
						const a = card.querySelector('a[href^="/t/task_"]')
						if (a) {
							const href = a.getAttribute('href')
							const match = href.match(/^\/t\/(task_[a-zA-Z0-9]+)/)
							return match ? match[1] : null
						}
					}
				}
				return null
			},
			hash_id
		)

		if (task_id) return task_id
		await wait(2000)
	}
	throw new Error('❌ Task ID з hash не знайдено')
}

async function createSoraTaskInStrapi({ prompt, hash_id, task_id }) {
	const res = await fetch(`${STRAPI_API_URL}/api/sora-tasks`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: STRAPI_TOKEN,
		},
		body: JSON.stringify({
			data: { prompt, hash_id, task_id, task_status: false },
		}),
	})
	if (!res.ok) throw new Error(await res.text())
	const data = await res.json()
	return data.data.documentId
}

async function updateSoraTaskStatus(documentId, status) {
	const res = await fetch(`${STRAPI_API_URL}/api/sora-tasks/${documentId}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			Authorization: STRAPI_TOKEN,
		},
		body: JSON.stringify({ data: { task_status: status } }),
	})
	if (!res.ok) throw new Error(await res.text())
}

async function waitFor4Images(page, task_id, timeout = 180000) {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		await page.goto(`https://sora.chatgpt.com/t/${task_id}`, {
			waitUntil: 'networkidle2',
		})
		const images = await page.$$eval('img', imgs =>
			imgs
				.map(img => img.src)
				.filter(src => src.startsWith('https://') && !src.startsWith('data:'))
		)
		if (images.length >= 4) {
			return images
		}
		await wait(20000)
	}
	throw new Error("❌ Не з'явилось 4 картинки за 3 хв")
}

async function uploadImageToStrapi(imageUrl) {
	const res = await fetch(`${STRAPI_API_URL}/api/upload-from-url`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: STRAPI_TOKEN,
		},
		body: JSON.stringify({ imageUrl }),
	})

	if (!res.ok) throw new Error(`Strapi error: ${await res.text()}`)
	const data = await res.json()
	return data[0]?.id
}

async function generateSoraImageFull(prompt) {
	const browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
		defaultViewport: { width: 1280, height: 800 },
	})
	const page = await browser.newPage()
	await loadCookies(page)
	await page.goto('https://sora.chatgpt.com/explore/images', {
		waitUntil: 'networkidle2',
	})

	const hash_id = genId()
	const fullPrompt = `${prompt}, ultra realistic, photorealistic, high resolution, professional photography, shot on Canon EOS, natural lighting, sharp focus, 8k, depth of field #${hash_id}`

	const maxWait = 300000
	const startWait = Date.now()
	while (true) {
		try {
			const empty = await isTextareaEmpty(page)
			if (empty) break
		} catch (e) {}
		if (Date.now() - startWait > maxWait)
			throw new Error('❌ Таймаут: textarea не очистилась')
		await wait(20000)
	}

	await page.focus('textarea[placeholder="Describe your image..."]')
	await page.type('textarea[placeholder="Describe your image..."]', fullPrompt)

	const buttons = await page.$$('button span.sr-only')
	let clicked = false
	for (const span of buttons) {
		const text = await page.evaluate(el => el.textContent.trim(), span)
		if (text === 'Create image') {
			await span.evaluate(el => el.closest('button').click())
			clicked = true
			break
		}
	}
	if (!clicked) throw new Error('❌ Кнопку Create image не знайдено')

	let promptAccepted = false
	for (let i = 0; i < 10; ++i) {
		await wait(2000)
		if (await isTextareaEmpty(page)) {
			promptAccepted = true
			break
		}
	}
	if (!promptAccepted)
		throw new Error('❌ Prompt не прийнятий — Sora вже зайнятий')

	const task_id = await waitForTaskIdByHash(page, hash_id)

	const documentId = await createSoraTaskInStrapi({ prompt, hash_id, task_id })

	const images = await waitFor4Images(page, task_id)
	const imageId = await uploadImageToStrapi(images[0])

	await updateSoraTaskStatus(documentId, true)

	await browser.close()
	return { imageId, imageUrl: images[0], hash_id, task_id, documentId }
}

app.post('/api/generate-sora-image', async (req, res) => {
	try {
		const { prompt } = req.body
		const result = await generateSoraImageFull(prompt)
		res.json(result)
	} catch (err) {
		console.error('❌ Error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

app.post('/api/generate-article', async (req, res) => {
	try {
		const { query } = req.body
		const openaiRes = await fetch(
			'https://api.openai.com/v1/chat/completions',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${OPENAI_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'gpt-4o',
					temperature: 0.7,
					messages: [
						{
							role: 'system',
							content: ` You are a CMS content generator. Return ONLY a valid raw JSON object — no markdown, no explanations,no backticks, no comments. Your output MUST start and end with { and }. Create an article in JSON format based on the topic: "${query}". The article must include exactly 2 paragraphs in the "paragraphs" array. JSON must always have property 'paragraphs' which is an array of EXACTLY 2 objects, no more, no less. Never reply with fewer or more than 2 items in the paragraphs array. The article should match this structure:
							{
								"title": "...",
								"description": ["... (min 700 characters)"],
								"isPopular": false,
								"paragraphs": [
									{
										"subtitle": "...",
										"description": ["... (min 700 characters)"],
										"ads": [
											{ "title": "...", "url": "https://..." },
											{ "title": "...", "url": "https://..." }
										],
										"image_prompt": "prompt for image generation"
									}
								],
								"ads": [
									{ "title": "...", "url": "https://..." },
									{ "title": "...", "url": "https://..." },
									{ "title": "...", "url": "https://..." }
								],
								"image_prompt": "main image prompt",
								"firstAdBanner": { "url": "https://...", "image_prompt": "..." },
								"secondAdBanner": { "url": "https://...", "image_prompt": "..." }
							}`,
						},
						{ role: 'user', content: query },
					],
				}),
			}
		)

		const data = await openaiRes.json()
		let raw = data.choices?.[0]?.message?.content ?? ''

		raw = raw
			.trim()
			.replace(/^```json\n?/, '')
			.replace(/```$/, '')

		try {
			const article = JSON.parse(raw)
			res.json({ article })
		} catch (parseErr) {
			console.error('❌ JSON parse error:', raw)
			res.status(500).json({ error: 'Invalid JSON from OpenAI', raw })
		}
	} catch (err) {
		console.error('❌ OpenAI error:', err)
		res.status(500).json({ error: 'Failed to generate article' })
	}
})

app.post('/api/create-post', async (req, res) => {
	try {
		const { article } = req.body
		const strapiRes = await fetch(`${STRAPI_API_URL}/api/posts`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: STRAPI_TOKEN,
			},
			body: JSON.stringify({ data: article }),
		})
		if (!strapiRes.ok) {
			const err = await strapiRes.text()
			throw new Error(err)
		}
		res.json({ success: true })
	} catch (err) {
		console.error('❌ Create-post error:', err)
		res.status(500).json({ error: err.message })
	}
})

app.get('/', (req, res) => {
	res.json({ status: 'ok', message: 'Server is running' })
})

app.listen(PORT, () => {
	console.log(`🚀 Server started on http://localhost:${PORT}`)
})
