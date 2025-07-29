import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs from 'fs/promises'

const COOKIES_PATH = './cookies.json'
const SORA_URL = 'https://sora.chatgpt.com'

puppeteer.use(StealthPlugin())

async function loginAndSaveCookies() {
	const browser = await puppeteer.launch({
		headless: false,
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	})

	const page = await browser.newPage()

	// Спроба завантажити попередні кукі
	try {
		const cookiesString = await fs.readFile(COOKIES_PATH, 'utf-8')
		const cookies = JSON.parse(cookiesString)
		await page.setCookie(...cookies)
		console.log('✅ Cookies завантажено з файлу')
	} catch {
		console.log('🔐 Cookies не знайдено — потрібен ручний логін')
	}

	// Відкриваємо Sora
	await page.goto(SORA_URL, { waitUntil: 'networkidle2' })
	console.log('🔃 Очікуємо логін користувача...')

	// Чекаємо появу сесійної куки
	let rawCookies = []
	const timeout = Date.now() + 5 * 60 * 1000

	while (Date.now() < timeout) {
		const pages = await browser.pages()
		for (const p of pages) {
			const client = await p.target().createCDPSession()
			const { cookies } = await client.send('Network.getAllCookies')

			const hasSession = cookies.some(
				c =>
					c.name === '__Secure-next-auth.session-token' ||
					c.name === 'next-auth.session-token'
			)

			if (hasSession) {
				rawCookies = cookies
				console.log(`🔑 Авторизаційна кука виявлена у вкладці: ${p.url()}`)
				break
			}
		}
		if (rawCookies.length) break
		await new Promise(r => setTimeout(r, 1000))
	}

	if (!rawCookies.length) {
		console.error('❌ Не виявлено куку логіну. Ймовірно, логін не завершено.')
		return
	}

	// 🔧 Фільтруємо поля для сумісності з setCookie
	const safeCookies = rawCookies.map(c => ({
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path || '/',
		expires: c.expires || -1,
		httpOnly: c.httpOnly || false,
		secure: c.secure || false,
		sameSite: c.sameSite || 'Lax',
	}))

	// 💾 Зберігаємо кукі у безпечному форматі
	await fs.writeFile(COOKIES_PATH, JSON.stringify(safeCookies, null, 2))
	console.log(`✅ Збережено ${safeCookies.length} кукі після логіну`)
}

loginAndSaveCookies()
