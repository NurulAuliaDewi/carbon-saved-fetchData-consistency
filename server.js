require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const schedule = require('node-schedule'); 
const app = express();
const port = 3000;

const pool = new Pool({
  user: process.env.DB_USER,        
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,   
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

let accessToken = process.env.STRAVA_ACCESS_TOKEN;
const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
const clientId = process.env.STRAVA_CLIENT_ID;
const clientSecret = process.env.STRAVA_CLIENT_SECRET;
const clubId = process.env.STRAVA_CLUB_ID;


async function refreshAccessToken() {
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', null, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });

    accessToken = response.data.access_token;
    console.log('Access token refreshed:', accessToken);

    return accessToken;
  } catch (error) {
    console.error('Error refreshing access token:', error.response ? error.response.data : error.message);
    return null;
  }
}

async function fetchStravaActivities() {
  try {
    const response = await axios.get(`https://www.strava.com/api/v3/clubs/${clubId}/activities`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params: {
        page: 1,
        per_page: 200,
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('Access token expired, refreshing token...');
      const newAccessToken = await refreshAccessToken();
      if (newAccessToken) {
        return fetchStravaActivities();
      } else {
        throw new Error('Unable to refresh access token');
      }
    } else {
      console.error('Error fetching data from Strava API:', error);
      return [];
    }
  }
}
async function saveActivitiesToDB(activities) {
  const client = await pool.connect();
  try {
    for (const activity of activities) {
      const {
        athlete,
        name,
        distance,
        moving_time,
        elapsed_time,
        total_elevation_gain,
        type: activity_type,
        sport_type,
        workout_type,
      } = activity;

      const athlete_firstname = athlete.firstname;
      const athlete_lastname = athlete.lastname;
      const activity_name = name;

      // --- FILTER SPORT TYPE ---
      const allowedSports = [
        'Ride',
        'MountainBikeRide',
        'GravelRide',
        'EBikeRide',
        'EMountainBikeRide',
        'Velomobile',
      ];
      if (!allowedSports.includes(sport_type)) {
        console.log(`Skipped activity "${activity_name}" because sport_type "${sport_type}" is not allowed.`);
        continue;
      }

      // --- CALCULATE SPEED (in km/h) ---
      const speed = moving_time > 0 ? (distance * 3.6) / moving_time : null;
      if (speed === null || speed < 5 || speed > 35) {
        console.log(`Skipped activity "${activity_name}" due to unrealistic speed (${speed?.toFixed(2)} km/h).`);
        continue;
      }

      const checkAthleteQuery = `
        SELECT id FROM athletes WHERE firstname = $1 AND lastname = $2
      `;
      const checkAthleteValues = [athlete_firstname, athlete_lastname];
      const checkAthleteResult = await client.query(checkAthleteQuery, checkAthleteValues);
      let athlete_id;

      if (checkAthleteResult.rows.length > 0) {
        athlete_id = checkAthleteResult.rows[0].id;
      } else {
        const insertAthleteQuery = `
          INSERT INTO athletes (firstname, lastname)
          VALUES ($1, $2)
          RETURNING id
        `;
        const insertAthleteValues = [athlete_firstname, athlete_lastname];
        const insertAthleteResult = await client.query(insertAthleteQuery, insertAthleteValues);
        athlete_id = insertAthleteResult.rows[0].id;
      }

      const checkActivityQuery = `
        SELECT id FROM club_activities
        WHERE id_athlete = $1
        AND distance = $2
        AND moving_time = $3
      `;

      const checkActivityValues = [
        athlete_id,
        distance,
        moving_time
      ];
      const checkActivityResult = await client.query(checkActivityQuery, checkActivityValues);

      if (checkActivityResult.rows.length > 0) {
        console.log(`Activity already exists for athlete "${athlete_firstname} ${athlete_lastname}".`);
        continue;
      }

      const carbon_saving = (distance / 1000) * 0.24;
      const datetimeUTC = new Date().toISOString();

      const insertQuery = `
        INSERT INTO club_activities (
          id_athlete, athlete_firstname, athlete_lastname, activity_name, distance, moving_time,
          elapsed_time, total_elevation_gain, activity_type, sport_type, workout_type, date, carbon_saving, datetime, speed
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15)
      `;

      const values = [
        athlete_id,
        athlete_firstname,
        athlete_lastname,
        activity_name,
        distance,
        moving_time,
        elapsed_time,
        total_elevation_gain,
        activity_type,
        sport_type,
        workout_type,
        new Date(),
        carbon_saving,
        datetimeUTC,
        speed
      ];

      await client.query(insertQuery, values);
      console.log(`Saved: "${activity_name}" for ${athlete_firstname} ${athlete_lastname} — Speed: ${speed.toFixed(2)} km/h`);
    }

    console.log('Data successfully saved to the database.');
  } catch (error) {
    console.error('Error saving data to the database:', error);
  } finally {
    client.release();
  }
}

  schedule.scheduleJob('*/10 * * * * *', async () => {
  // schedule.scheduleJob('*/15 * * * *', async () => {
  console.log('Starting the sync process...');
  const activities = await fetchStravaActivities();
  if (activities.length > 0) {
    await saveActivitiesToDB(activities);
    console.log('Activities synced and saved to the database!');
  } else {
    console.log('No activities found or failed to fetch data.');
  }
});

app.get('/', async (req, res) => {
res.status(200).send('success');
});

app.get('/sync-activities', async (req, res) => {
  const activities = await fetchStravaActivities();
  if (activities.length > 0) {
    await saveActivitiesToDB(activities);
    res.status(200).send('Activities synced and saved to database!');
  } else {
    res.status(500).send('No activities found or failed to fetch data.');
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Server is running on http://127.0.0.1:${port}`);
});
