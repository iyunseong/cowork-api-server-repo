const Sequelize = require("sequelize");
const config = require("../config/config.json");

const { username, password, database, host, dialect } = config.development;
const sequelize = new Sequelize(database, username, password, {
  host,
  dialect,
});

const Member = require("./member.js")(sequelize, Sequelize.DataTypes);

const db = {};
db.Member = Member;

module.exports = db;
