-- 001_initial_schema.sql
-- Original Task 21B schema (technicians, service_requests, dispatch_offers).
--
-- Written as CREATE ... IF NOT EXISTS so it can be applied safely to an
-- existing Task 21B database (the migration runner had no ledger back
-- then) as well as to a brand new database. Never drops or rewrites
-- existing tables or data.
--
-- Applied first, in filename order, by src/db/migrate.ts.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS technicians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  skills JSONB NOT NULL,
  service_area TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  rating DOUBLE PRECISION,
  jobs INTEGER,
  verified BOOLEAN,
  availability TEXT,
  availability_status TEXT,
  account_status TEXT,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_technicians_location ON technicians USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_service_requests_city ON service_requests(city);
CREATE INDEX IF NOT EXISTS idx_offers_request_id ON dispatch_offers(request_id);
CREATE INDEX IF NOT EXISTS idx_offers_technician_id ON dispatch_offers(technician_id);
