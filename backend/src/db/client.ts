import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

export async function getClient() {
  const client = await pool.connect();
  return client;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const client = await getClient();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// NOTE (Task 23): schema creation moved out of this file. The schema is now
// owned by the deterministic migration runner in src/db/migrate.ts, which
// applies the ordered SQL files in src/db/migrations/ (001_initial_schema,
// 002_authentication, …) and records them in schema_migrations. Do not add
// CREATE TABLE statements here.

export async function seedInitialTechnicians() {
  const technicians = [
    {
      name: 'Chanda M.',
      category: 'Electrical',
      skills: ['Home wiring'],
      serviceArea: 'Kitwe',
      rating: 4.8,
      jobs: 42,
      verified: true,
      availability: 'Available now',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.8162,
      longitude: 28.1995,
    },
    {
      name: 'Bwalya K.',
      category: 'Plumbing',
      skills: ['Pipe repair'],
      serviceArea: 'Ndola',
      rating: 4.7,
      jobs: 35,
      verified: true,
      availability: 'Available today',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.9641,
      longitude: 28.6272,
    },
    {
      name: 'Mwamba T.',
      category: 'ICT',
      skills: ['Networking'],
      serviceArea: 'Kitwe',
      rating: 4.9,
      jobs: 51,
      verified: true,
      availability: 'Available now',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.8038,
      longitude: 28.2164,
    },
    {
      name: 'Mulenga P.',
      category: 'Appliance Repair',
      skills: ['Electronics'],
      serviceArea: 'Ndola',
      rating: 4.6,
      jobs: 28,
      verified: false,
      availability: 'Unavailable',
      availabilityStatus: 'unavailable',
      accountStatus: 'active',
      latitude: -12.9498,
      longitude: 28.6453,
    },
    {
      name: 'Kabwe S.',
      category: 'Automotive',
      skills: ['Brake servicing', 'Tyre changes'],
      serviceArea: 'Kitwe',
      rating: 4.5,
      jobs: 33,
      verified: true,
      availability: 'Available today',
      availabilityStatus: 'available',
      accountStatus: 'inactive',
      latitude: -12.8217,
      longitude: 28.2131,
    },
    {
      name: 'Nkonde R.',
      category: 'HVAC',
      skills: ['Air conditioning maintenance'],
      serviceArea: 'Ndola',
      rating: 4.6,
      jobs: 26,
      verified: false,
      availability: 'Available now',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.9715,
      longitude: 28.6348,
    },
    {
      name: 'Phiri D.',
      category: 'Refrigeration',
      skills: ['Fridge repair', 'Cooler servicing'],
      serviceArea: 'Kitwe',
      rating: 4.7,
      jobs: 31,
      verified: true,
      availability: 'Available today',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.8071,
      longitude: 28.1896,
    },
    {
      name: 'Sakala B.',
      category: 'Electronics',
      skills: ['TV repair', 'Stereo systems'],
      serviceArea: 'Ndola',
      rating: 4.4,
      jobs: 22,
      verified: true,
      availability: 'Available now',
      availabilityStatus: 'available',
      accountStatus: 'suspended',
      latitude: -12.9472,
      longitude: 28.6218,
    },
    {
      name: 'Mumba J.',
      category: 'Handyman',
      skills: ['Painting', 'Furniture assembly'],
      serviceArea: 'Kitwe',
      rating: 4.6,
      jobs: 40,
      verified: false,
      availability: 'Available today',
      availabilityStatus: 'available',
      accountStatus: 'active',
      latitude: -12.8184,
      longitude: 28.2245,
    },
  ];

  // Insert only if table is empty (pg returns COUNT(*) as a string)
  const countResult = await query('SELECT COUNT(*) AS count FROM technicians');
  if (Number(countResult[0].count) === 0) {
    const values = technicians.map((t) => [
      t.name,
      t.category,
      JSON.stringify(t.skills),
      t.serviceArea,
      t.latitude,
      t.longitude,
      t.rating,
      t.jobs,
      t.verified,
      t.availability,
      t.availabilityStatus,
      t.accountStatus,
      `POINT(${t.longitude} ${t.latitude})`, // PostGIS point
    ]);

    // Use client for bulk insert to avoid serialization issues
    const client = await getClient();
    for (const v of values) {
      await client.query(
        'INSERT INTO technicians (name, category, skills, service_area, latitude, longitude, rating, jobs, verified, availability, availability_status, account_status, location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,ST_GeomFromText($13, 4326))',
        v
      );
    }
    client.release();
    console.log('Initial technicians seeded.');
  } else {
    console.log('Technicians already exist, skipping seed.');
  }
}