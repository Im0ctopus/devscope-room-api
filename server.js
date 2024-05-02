const express = require('express')
const { graphqlHTTP } = require('express-graphql')
const graphql = require('graphql')
require('dotenv').config()
const { Client } = require('pg')
const joinMonster = require('join-monster')
const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  service: 'Hotmail',
  auth: {
    user: 'rooms.alert@hotmail.com',
    pass: process.env.MAIL_PASSWORD,
  },
})

//Connect to db
const client = new Client({
  host: process.env.HOST,
  user: process.env.USER,
  password: process.env.PASSWORD,
  database: process.env.DATABASE,
  ssl: {
    rejectUnauthorized: false,
  },
})
client.connect()

const Room = new graphql.GraphQLObjectType({
  name: 'Rooms',
  fields: () => ({
    id: { type: graphql.GraphQLInt },
    name: { type: graphql.GraphQLString },
    busystart: { type: graphql.GraphQLFloat },
    busyend: { type: graphql.GraphQLFloat },
    organizer: { type: graphql.GraphQLString },
    busy: { type: graphql.GraphQLBoolean },
    waiting: {
      type: new graphql.GraphQLList(Waiting),
      extensions: {
        joinMonster: {
          sqlJoin: (roomTable, waitingTable, args) =>
            `${roomTable}.id = ${waitingTable}.roomid`,
          orderBy: 'id',
        },
      },
    },
  }),
  extensions: {
    joinMonster: {
      sqlTable: 'room',
      uniqueKey: 'id',
    },
  },
})

const Waiting = new graphql.GraphQLObjectType({
  name: 'Waiting',
  fields: () => ({
    id: { type: graphql.GraphQLInt },
    email: { type: graphql.GraphQLString },
    name: { type: graphql.GraphQLString },
    roomid: { type: graphql.GraphQLInt },
  }),
  extensions: {
    joinMonster: {
      sqlTable: 'waiting',
      uniqueKey: 'id',
    },
  },
})

const QueryRoot = new graphql.GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    rooms: {
      type: new graphql.GraphQLList(Room),
      resolve: (parent, args, context, resolveInfo) => {
        return joinMonster.default(resolveInfo, {}, (sql) => {
          return client.query(sql)
        })
      },
    },
    waiting: {
      type: Waiting,
      args: {
        waitid: { type: new graphql.GraphQLNonNull(graphql.GraphQLInt) },
      },
      extensions: {
        joinMonster: {
          where: (waitingTable, args, context) => {
            return `${waitingTable}.id = ${args.waitid}`
          },
        },
      },
      resolve: (parent, args, context, resolveInfo) => {
        return joinMonster.default(resolveInfo, {}, (sql) => {
          return client.query(sql)
        })
      },
    },
  }),
})

const MutationRoot = new graphql.GraphQLObjectType({
  name: 'Mutation',
  fields: () => ({
    waiting: {
      type: Waiting,
      args: {
        email: { type: graphql.GraphQLNonNull(graphql.GraphQLString) },
        name: { type: graphql.GraphQLNonNull(graphql.GraphQLString) },
        roomid: { type: new graphql.GraphQLNonNull(graphql.GraphQLInt) },
      },
      resolve: async (parent, args, context, resolveInfo) => {
        try {
          return (
            await client.query(
              'INSERT INTO waiting(email, name, roomid) VALUES ($1,$2,$3) RETURNING *',
              [args.email, args.name, args.roomid]
            )
          ).rows[0]
        } catch (err) {
          console.error('Error inserting into waiting:', err)
          throw new Error('Failed to insert into waiting')
        }
      },
    },
    cancel: {
      type: Room,
      args: {
        roomid: { type: graphql.GraphQLNonNull(graphql.GraphQLInt) },
      },
      resolve: async (parent, args, context, resolveInfo) => {
        try {
          return (
            await client.query(
              'UPDATE Room SET BusyStart = NULL, BusyEnd = NULL, Organizer = NULL, Busy = FALSE WHERE Id = $1 RETURNING *',
              [args.roomid]
            )
          ).rows[0]
        } catch (err) {
          console.error('Failed to cancel:', err)
          throw new Error('Failed to cancel')
        }
      },
    },
    remove: {
      type: Waiting,
      args: {
        waitid: { type: graphql.GraphQLNonNull(graphql.GraphQLInt) },
      },
      resolve: async (parent, args, context, resolveInfo) => {
        try {
          return (
            await client.query(
              'DELETE FROM waiting WHERE id = $1 RETURNING *',
              [args.waitid]
            )
          ).rows[0]
        } catch (err) {
          console.error('Failed to remove:', err)
          throw new Error('Failed to remove')
        }
      },
    },
  }),
})

const schema = new graphql.GraphQLSchema({
  query: QueryRoot,
  mutation: MutationRoot,
})

const authenticateToken = (req, res, next) => {
  const authToken = req.headers['authorization']
  const token = process.env.API_TOKEN
  if (authToken === `Bearer ${token}`) {
    next()
  } else {
    res.sendStatus(403)
  }
}

const app = express()
app.use(
  '/api',
  authenticateToken,
  graphqlHTTP({
    schema: schema,
    graphiql: true,
  })
)
app.listen(process.env.PORT || 4000)

//The part that verifies and send mails
setInterval(async () => {
  //Update my database from the rooms API
  const fetchRooms = async () => {
    const res = await fetch(process.env.API_LINK ?? '', {
      headers: {
        'Content-Type': 'application/json',
        Cookie: process.env.COOKIE ?? '',
      },
    })
    if (!res.ok) throw new Error('Erro a obter a informação da API')
    return await res.json()
  }
  const roomsApi = await fetchRooms()
  const roomsDb = (await client.query('SELECT * from room')).rows
  for (let i = 0; i < roomsApi.length; i++) {
    if (roomsDb[i]) {
      if (!roomsDb[i].busy && roomsApi[i].busy) {
        //NOT TESTED
        await client.query(
          'UPDATE room SET busystart = $1, busyend = $2, organizer = $3, busy = TRUE WHERE name = $4',
          [
            roomsApi[i].Appointments[0].Start,
            roomsApi[i].Appointments[0].End,
            roomsApi[i].Appointments[0].Organizer,
            roomsDb[i].id,
          ]
        )
        console.log('Room updated to Busy')
      } else if (roomsDb[i].busy && roomsApi[i].busy) {
        //NOT TESTED
        if (
          roomsDb[i].organizer != roomsApi[i].Appointments[0].Organizer ||
          roomsDb[i].busystart != roomsApi[i].Appointments[0].Start
        ) {
          await client.query(
            'UPDATE room SET busystart = $1, busyend = $2, organizer = $3, busy = TRUE WHERE name = $4',
            [
              roomsApi[i].Appointments[0].Start,
              roomsApi[i].Appointments[0].End,
              roomsApi[i].Appointments[0].Organizer,
              roomsDb[i].id,
            ]
          )
          console.log('Room updated, it got a reservation.')
        }
      } else if (roomsDb[i].busy) {
        const current = new Date()
        const busyEnd = new Date(parseFloat(roomsDb[i].busyend))
        if (current > busyEnd) {
          //WORKING
          await client.query(
            'UPDATE room SET busystart = NULL, busyend = NULL, organizer = NULL, busy = false WHERE id = $1',
            [roomsDb[i].id]
          )
          console.log('Room updated to Free')
        }
      }
    } else {
      console.log('Table not on the database, creating')
      if (roomsApi[i].busy) {
        //NOT TESTED
        await client.query(
          'INSERT INTO room (name,busystart,busyend,organizer,busy) VALUES($1,$2,$3,$4,$5)',
          [
            roomsApi[i].Name,
            roomsApi[i].Appointments[0].Start,
            roomsApi[i].Appointments[0].End,
            roomsApi[i].Appointments[0].Organizer,
            true,
          ]
        )
      } else {
        //WORKING
        await client.query('INSERT INTO room (name,busy) VALUES($1,$2)', [
          roomsApi[i].Name,
          false,
        ])
      }
    }
  }
  //Verify the rooms and send email if free
  const roomsWaited = (
    await client.query('SELECT DISTINCT RoomId FROM Waiting;')
  ).rows
  for (let i = 0; i < roomsWaited.length; i++) {
    const busy = (
      await client.query('SELECT busy FROM room WHERE id = $1', [
        roomsWaited[i].roomid,
      ])
    ).rows[0].busy
    if (busy) {
      console.log('The room is still busy.')
    } else {
      console.log('The room is free sending email.')
      //Deletes the waiting list "user" that was first introduced and returns mail
      const waiting = (
        await client.query(
          'WITH lowestid AS (SELECT id FROM waiting WHERE roomid = $1 ORDER BY id LIMIT 1) DELETE FROM waiting WHERE id IN (SELECT id FROM lowestid) RETURNING email, name',
          [roomsWaited[i].roomid]
        )
      ).rows[0]
      //Updates the room to busy with the end time +30min from the current
      const current = new Date().getTime()
      const room = (
        await client.query(
          'UPDATE room SET busystart = $1, busyend = $2, organizer = $3, busy = TRUE WHERE id = $4 RETURNING name,id',
          [
            current,
            current + 1800000, //adiciona 30 min
            waiting.name,
            roomsWaited[i].roomid,
          ]
        )
      ).rows[0]
      //Email sender
      const mailOptions = {
        from: 'rooms.alert@hotmail.com',
        to: waiting.email,
        subject: 'Your room is free',
        html:
          '<p>The ' +
          room.name +
          " is free for reservation. You have 30 minutes to reserve it. Otherwise, an email will be sent to the next person on the waiting list.</p> <p>If you don't need the room anymore please click on the link: http://localhost:3000/api/cancel/" +
          room.id +
          '</p>',
      }
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log(error)
        } else {
          console.log('Email sent: ' + info.response)
        }
      })
    }
  }
}, 10000)
