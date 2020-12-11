const Knex = require("knex")
const dotenv = require("dotenv").config()

const knex = database => {
	const db = Knex({
		client: "mysql",
		useNullAsDefault: true,
		connection: {
			host: process.env.DB_HOST,
			database: database,
			user: process.env.DB_USER,
			password: process.env.DB_PASS,
			supportBigNumbers: true,
		},
	})

	return db
}

module.exports = knex
