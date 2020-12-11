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
		// Check if they have a valid user session.
		if (req.session.user) {
			req.method = "USER"
			req.method_value = req.session.user.id
			return next()
		}

		// Check if they have a valid session_id cookie
		if (req.cookies.sessionId) {
			const hasSession = await knex("sessions").where("session_id", req.cookies.sessionId).first()
			if (hasSession) {
				req.method = "SESSION"
				req.method_value = req.cookies.sessionId
				return next()
			} else {
				res.clearCookie("sessionId")
			}
		}

		// Check IP is authed then redirect the user.
		const ipIsAuthed = await knex("ips").where("ip_address", req.ip).first()
		if (ipIsAuthed) {
			req.method = "IP"
			req.method_value = req.ip
			return next()
		}

		// Return unauthorized
		return res.status(401).render("unauthorized.handlebars")
	},
	async (req, res) => {
		// We have to be careful here because there can be an unlimited amount of user sessions
		// We will record outbound traffic requests incase of anything malicious
		await knex("outbound").insert({
			ip_address: req.ip,
			user_agent: req.headers["user-agent"],
			code: req.params.code,
			auth_method: req.method,
			auth_value: req.method_value,
		})

		// Select shortlink (get lastest one in case of duplicates)
		const shortlink = await knex("shortlinks").where("code", req.params.code).orderBy("id", "DESC").first()

		if (!shortlink) {
			return res.render("404.handlebars")
		}

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

app.get("/", authed, async (req, res) => {
	// Update user
	req.session.user.ips = (await knex("ips").where("user_id", req.session.user.id)).map(row => row.ip_address)
	req.session.user.sessions = await knex("sessions").where("user_id", req.session.user.id)

	return res.render("dashboard.handlebars", {
		ip: req.ip,
		ips: req.session.user.ips,
		sessions: req.session.user.sessions,
	})
})

app.post("/", authed, async (req, res) => {
	if (req.body.type === "ip_change") {
		const { ip_1, ip_2 } = req.body

		// Delete their current IPs from the database & resave them
		try {
			await knex("ips").where("user_id", req.session.user.id).delete()

			if (ip_1) {
				await knex("ips").insert({
					user_id: req.session.user.id,
					ip_address: ip_1,
				})
			}

			if (ip_2) {
				await knex("ips").insert({
					user_id: req.session.user.id,
					ip_address: ip_2,
				})
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
		const currentSession = await knex("sessions").where("session_id", req.cookies.sessionId).first()
		if (currentSession) {
			validSession = true
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
			session_id: sessionId,
			user_id: user.id,
			user_agent: req.headers["user-agent"],
		})

		// Used for tracking malicious activity.
		await knex("saved_sessions").insert({
			session_id: sessionId,
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
