const dotenv = require("dotenv").config()
const express = require("express")
const knex = require("./libs/database")(process.env.DB_NAME)
const handlebars = require("express-handlebars")
const session = require("express-session")
const bcrypt = require("bcryptjs")
const bodyParser = require("body-parser")
const { v4: uuidv4 } = require("uuid")
const cookieParser = require("cookie-parser")

const app = express()

app.engine(
	"handlebars",
	handlebars({
		layoutsDir: __dirname + "/views/layouts",
	})
)

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cookieParser())

/**
 * You may need to configure forwarding IPs if you're using NGINX as a reverse proxy
 */

const sess = {
	secret: process.env.SECRET,
	cookie: {},
	resave: true,
	saveUninitialized: true,
}

if (process.env.ENV === "production") {
	app.set("trust proxy", 1)
	sess.cookie.secure = true
}

app.use(session(sess))

app.use(function (req, res, next) {
	// req.session.user = true

	// Careful with this, if you're not using a reverse proxy people could just spoof x-forwarded-for and "pretend" to be an IP address
	// This was designed for use with NGINX but would be really easy to convert for any other platform.
	req.ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress
	next()
})

/**
 * Authentication middleware. Check if the user has an active browser session or has their IP authed.
 */

const authed = async (req, res, next) => {
	if (req.session.user) {
		return next()
	}

	// Return unauthorized
	return res.redirect("/login")
}

/**
 * Homepage, this is the "control panel".
 * It requires authentication to access. This lets the user customise their IP address and manage their browser sessions.
 */

app.get(
	"/l/:code",
	async (req, res, next) => {
		/**
		 * So I discussed this a fair bit with Prism's @mzchael_ - We concluded that if a user is spoofing a sessionId cookie then it doesn't really matter how long it takes for them to be redirected because they're trying be malicious. A user using an expired browser session would be quite rare and ideally we want to only do a two-table lookup (user,session or user,ip) rather than using multiple joins and comparing them all at once, we could also improve this by using redis/memcache for faster lookups than db queries.
		 */

		// Check if they have a valid user session (No query required)
		if (req.session.user) {
			req.method_name = "USER"
			req.method_value = req.user_id = req.session.user.id

			if (req.session.user.member) {
				return next()
			}
		}

		// Check if they have a valid session_id cookie.
		if (req.cookies.sessionId) {
			const session = await knex("users")
				.select(["users.id", "users.member", "sessions.id as session_id"])
				.innerJoin("sessions", "sessions.user_id", "=", "users.id")
				.where("sessions.id", req.cookies.sessionId)
				.first()

			if (session && session.member) {
				req.method_name = "SESSION"
				req.method_value = req.cookies.sessionId
				req.user_id = session.id
				return next()
			} else if (!session) {
				// We could also log the session and compare it against the "saved_sessions" table to see if it _used_ to be active or was spoofed.
				res.clearCookie("sessionId")
			}
		}

		// Check IP is authed then redirect the user.
		const ip = req.ip || null
		const ipSession = await knex("users")
			.select(["users.id", "users.member", "ips.ip_address"])
			.innerJoin("ips", "ips.user_id", "=", "users.id")
			.where("ips.ip_address", ip)
			.first()

		if (ipSession && ipSession.member) {
			req.method_name = "IP"
			req.method_value = req.ip
			req.user_id = ipSession.id
			return next()
		}

		// Return unauthorized
		return res.status(401).render("unauthorized.handlebars")
	},
	async (req, res) => {
		// We have to be careful here because there can be an unlimited amount of user sessions
		// We will record outbound traffic requests incase of anything malicious
		knex("outbound")
			.insert({
				ip_address: req.ip,
				user_agent: req.headers["user-agent"],
				code: req.params.code,
				auth_method: req.method_name,
				auth_value: req.method_value,
			})
			.then(res => {
				// Successfully stored traffic data.
			})

		// Select shortlink (get lastest one in case of duplicates)
		const shortlink = await knex("shortlinks").where("code", req.params.code).orderBy("id", "DESC").first()

		if (!shortlink) {
			return res.render("404.handlebars")
		}

		// Link obfuscation techniques:
		if (shortlink.linkbust) {
			const techniques = shortlink.linkbust.split("|")
			for (const technique of techniques) {
				switch (technique) {
					// Random capitalization
					case "CAPITALS":
						shortlink.destination = shortlink.destination
							.split("")
							.map(v => (Math.round(Math.random()) ? v.toUpperCase() : v.toLowerCase()))
							.join("")
						break
					case "CACHEBUST":
						// Random query parameter
						const url = new URL(shortlink.destination)
						const ranKey = rs(5)
						const ranVal = rs(5)
						url.searchParams.append(ranKey, ranVal)
						shortlink.destination = url.href
						break
					case "RANDOM":
						// Replace %RAN% inside URL with random values
						for (let i = 0; i < shortlink.destination.split("%RAN%").length; i++) {
							const ran = rs(5)
							shortlink.destination = shortlink.destination.replace("%RAN%", ran)
						}

						break
				}
			}
		}

		knex("dynamic_urls")
			.insert({
				user_id: req.user_id,
				full_url: shortlink.destination,
			})
			.then(res => {
				console.log(`[USER: ${req.user_id}] ACCESS: ${shortlink.destination}`)
			})

		if (shortlink.method === "GET") {
			return res.redirect(shortlink.destination)
		} else {
			return res.render("postlink.handlebars", {
				data: JSON.parse(shortlink.data),
				destination: shortlink.destination,
			})
		}
	}
)

app.post("/l", async (req, res) => {
	/**
	 * You will want to add some admin/private key authentication here so not anyone can create a link.
	 * You can also save the link directly to the database from a script rather than doing through an API which would require a HTTP request rather than just a single SQL query.
	 * If a code is not set it will be randomly generated.
	 */

	let code = req.body.code
	if (!code) {
		code = rs(5)
	}

	/**
	 * Link bust should be an array containing the type of link obfuscation you want to perform to the URL
	 */

	if (!req.body.method) {
		return res.status(400).json({
			error: "Missing `method` parameter.",
		})
	}

	if (!["GET", "POST"].includes(req.body.method.toUpperCase())) {
		return res.status(400).json({
			error: "Invalid `method` parameter. The method must either be POST or GET.",
		})
	}

	if (!req.body.destination) {
		return res.status(400).json({
			error: "Missing `destination` parameter.",
		})
	}

	if (req.body.data) {
		if (req.body.method === "GET") {
			return res.status(400).json({
				error: "A method of `GET` cannot contain form-data.",
			})
		}

		if (typeof req.body.data !== "object") {
			return res.status(400).json({
				error: "The `data` parameter must be a key-value object.",
			})
		}
	}

	// The order of linkbusting is important, this script automatically corrects that.
	let linkbustList = req.body.linkbust ? [] : null
	if (req.body.linkbust) {
		if (typeof req.body.linkbust !== "object") {
			return res.status(400).json({
				error: "The `linkbust` parameter must be an array.",
			})
		}

		linkbust = req.body.linkbust.map(lb => lb.toUpperCase())

		if (linkbust.includes("RANDOM")) {
			linkbustList.push("RANDOM")
		}

		if (linkbust.includes("CACHEBUST")) {
			linkbustList.push("CACHEBUST")
		}

		if (linkbust.includes("CAPITALS")) {
			linkbustList.push("CAPITALS")
		}

		linkbustList = linkbustList.join("|")
	}

	knex("shortlinks")
		.insert({
			code: code,
			method: req.body.method.toUpperCase(),
			data: req.body.data ? JSON.stringify(req.body.data) : null,
			destination: req.body.destination,
			linkbust: linkbustList,
		})
		.then(res => {
			console.log(`[SHORTLINK] [${code}] Shortlink destined to: ${req.body.destination} has been created`)
		})
		.catch(err => {
			console.log(`[SHORTLINK] [${code}] There was an error trying to save the link inside the database. ${err.message}`)
		})

	return res.json({
		message: "Shortlink creation in progress.",
		code: code,
	})
})

app.get("/links", authed, async (req, res) => {
	return res.render("links.handlebars")
})

app.get("/", authed, async (req, res) => {
	// Update user
	req.session.user.ips = (await knex("ips").where("user_id", req.session.user.id)).map(row => row.ip_address)
	req.session.user.sessions = await knex("sessions").where("user_id", req.session.user.id)

	return res.render("dashboard.handlebars", {
		ip: req.ip,
		ips: req.session.user.ips,
		sessions: req.session.user.sessions,
		member: req.session.user.member,
	})
})

app.post("/", authed, async (req, res) => {
	if (req.body.type === "ip_change") {
		const { ip_1, ip_2 } = req.body

		// Delete their current IPs from the database & resave them, we also save all the IPs used/changed inside saved_ips so we can relate them to any outbound traffic session
		// IP format validation could be added here...
		try {
			await knex("ips").where("user_id", req.session.user.id).delete()

			if (ip_1) {
				const ip = {
					user_id: req.session.user.id,
					ip_address: ip_1,
				}

				await knex("ips").insert(ip)
				await knex("saved_ips").insert(ip)
			}

			if (ip_2) {
				const ip = {
					user_id: req.session.user.id,
					ip_address: ip_2,
				}

				await knex("ips").insert(ip)
				await knex("saved_ips").insert(ip)
			}

			req.session.user.ips = (await knex("ips").where("user_id", req.session.user.id)).map(row => row.ip_address)
		} catch (err) {
			return res.render("dashboard.handlebars", {
				ip_error: "There was an erroring trying to update your IP addresses.",
			})
		}
	}

	return res.redirect("/")
})

app.get("/login", (req, res) => {
	if (req.session.user) {
		return res.redirect("/")
	}

	return res.render("login.handlebars")
})

app.post("/login", async (req, res) => {
	// Check if login details are correct
	const { email, password } = req.body

	if (!email) {
		return res.status(400).render("login.handlebars", {
			error: "Missing email address.",
		})
	}

	if (!password) {
		return res.status(400).render("login.handlebars", {
			error: "Missing password.",
		})
	}

	const user = await knex("users").where("email", email).first()
	if (!user) {
		return res.status(400).render("login.handlebars", {
			error: "User does not exist.",
		})
	}

	const match = await bcrypt.compare(password, user.password)
	if (!match) {
		return res.status(400).render("login.handlebars", {
			error: "Invalid password.",
		})
	}

	// Check the cookie the user has is actually valid (remember, cookies can be spoofed)
	let validSession = false
	if (req.cookies.sessionId) {
		const currentSession = await knex("sessions").where("id", req.cookies.sessionId).first()
		if (currentSession) {
			if (currentSession.user_id === user.id) {
				validSession = true
			} else {
				// A clash between two account sessions, you could perform logging here.
			}
		}
	}

	// Set a cookie on the users browser with their browser session ID and create a session in the database

	if (!req.cookies.sessionId && !validSession) {
		const sessionId = uuidv4()
		const currentSessions = await knex("sessions").where("user_id", user.id).orderBy("id", "ASC")

		if (currentSessions.length === 5) {
			const lastSession = currentSessions[0]
			// Delete oldest session
			await knex("sessions").where("user_id", user.id).where("id", lastSession.id).delete()
		}

		await knex("sessions").insert({
			id: sessionId,
			user_id: user.id,
			user_agent: req.headers["user-agent"],
		})

		// Used for tracking malicious activity.
		await knex("saved_sessions").insert({
			id: sessionId,
			user_id: user.id,
			user_agent: req.headers["user-agent"],
			ip_address: req.ip,
		})

		res.cookie("sessionId", sessionId)
	}

	// Pull latest information from database and store in session
	req.session.user = user
	req.session.user.ips = (await knex("ips").where("user_id", user.id)).map(row => row.ip_address)
	req.session.user.sessions = await knex("sessions").where("user_id", user.id)

	return res.redirect("/")
})

app.listen(process.env.PORT, () => {
	console.log(`[AUTHCORD] Authcording listening at http://localhost:${process.env.PORT}`)
})

function rs(length) {
	/**
	 * Thanks stackoverflow. I use this wayyy too much.
	 */

	let result = ""
	let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	let charactersLength = characters.length
	for (let i = 0; i < length; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength))
	}
	return result
}
