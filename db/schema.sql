-- Ashhar RO Water — database schema (MySQL 8 / MariaDB 10.6+).
-- Safe to run more than once: every table is created only if it does not exist.

CREATE TABLE IF NOT EXISTS company (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  name VARCHAR(120) NOT NULL,
  name_hindi VARCHAR(120) NULL,
  phone VARCHAR(20) NULL,
  whatsapp VARCHAR(20) NULL,
  email VARCHAR(120) NULL,
  address VARCHAR(255) NULL,
  gstin VARCHAR(20) NULL,
  logo_url VARCHAR(255) NULL,
  jar_rate DECIMAL(8, 2) NOT NULL DEFAULT 15, -- default price per 20L jar for new customers
  camper_rate DECIMAL(8, 2) NOT NULL DEFAULT 20,
  jar_deposit DECIMAL(8, 2) NOT NULL DEFAULT 150,
  camper_deposit DECIMAL(8, 2) NOT NULL DEFAULT 400,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  mobile VARCHAR(10) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('owner', 'manager', 'accounts') NOT NULL DEFAULT 'manager',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_admin_mobile (mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_boys (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  mobile VARCHAR(10) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_boy_mobile (mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS routes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  areas TEXT NULL, -- JSON array of area names, for display
  delivery_boy_id INT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_routes_boy (delivery_boy_id),
  CONSTRAINT fk_routes_boy FOREIGN KEY (delivery_boy_id) REFERENCES delivery_boys (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A different delivery boy covers a route for one day (leave).
CREATE TABLE IF NOT EXISTS route_covers (
  route_id INT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  delivery_boy_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (route_id, date),
  KEY ix_cover_boy (delivery_boy_id, date),
  CONSTRAINT fk_cover_route FOREIGN KEY (route_id) REFERENCES routes (id) ON DELETE CASCADE,
  CONSTRAINT fk_cover_boy FOREIGN KEY (delivery_boy_id) REFERENCES delivery_boys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
  id VARCHAR(12) NOT NULL PRIMARY KEY, -- RO-0001
  seq INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  mobile VARCHAR(10) NOT NULL,
  address VARCHAR(255) NOT NULL,
  area VARCHAR(80) NOT NULL,
  route_id INT UNSIGNED NULL,
  route_order INT NOT NULL DEFAULT 0,
  lat DECIMAL(9, 6) NULL,
  lng DECIMAL(9, 6) NULL,
  product ENUM('jar', 'camper') NOT NULL DEFAULT 'jar',
  jars_per_day TINYINT UNSIGNED NOT NULL DEFAULT 1,
  rate_per_jar DECIMAL(8, 2) NOT NULL,
  schedule_type ENUM('daily', 'alternate', 'weekdays') NOT NULL DEFAULT 'daily',
  schedule_days VARCHAR(20) NULL, -- '1,2,3,4,5,6' (0 = Sunday)
  start_date DATE NOT NULL, -- first day tracked and billed by the system
  deposit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  jars_issued INT NOT NULL DEFAULT 0,
  opening_balance DECIMAL(10, 2) NOT NULL DEFAULT 0, -- dues carried over from the old register
  joined_on DATE NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_customer_seq (seq),
  UNIQUE KEY uq_customer_mobile (mobile),
  KEY ix_customer_route (route_id, route_order),
  CONSTRAINT fk_customer_route FOREIGN KEY (route_id) REFERENCES routes (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One status per customer per day.
CREATE TABLE IF NOT EXISTS delivery_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(12) NOT NULL,
  date DATE NOT NULL,
  status ENUM('delivered', 'extra', 'not_taken', 'not_available', 'paused') NOT NULL,
  jars_delivered INT NOT NULL DEFAULT 0,
  empties_collected INT NOT NULL DEFAULT 0,
  rate_per_jar DECIMAL(8, 2) NOT NULL,
  remarks VARCHAR(300) NULL,
  photo_url VARCHAR(255) NULL,
  delivery_boy_id INT UNSIGNED NULL, -- NULL = system (auto-paused) or admin correction
  delivery_boy_name VARCHAR(80) NOT NULL,
  client_id VARCHAR(64) NULL,
  recorded_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_entry_day (customer_id, date),
  KEY ix_entry_date (date),
  KEY ix_entry_boy (delivery_boy_id, date),
  CONSTRAINT fk_entry_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(64) NULL,
  customer_id VARCHAR(12) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  mode ENUM('cash', 'upi', 'online') NOT NULL,
  reference VARCHAR(60) NULL,
  date DATE NOT NULL,
  note VARCHAR(255) NULL,
  recorded_by_type ENUM('admin', 'delivery', 'online') NOT NULL,
  recorded_by_id INT UNSIGNED NULL,
  recorded_by_name VARCHAR(80) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_payment_client (client_id),
  KEY ix_payment_customer (customer_id, date),
  KEY ix_payment_date (date),
  CONSTRAINT fk_payment_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Remembers every offline-sync request so a retry never saves twice.
CREATE TABLE IF NOT EXISTS sync_receipts (
  client_id VARCHAR(64) NOT NULL PRIMARY KEY,
  kind ENUM('entry', 'payment') NOT NULL,
  ref_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(12) NOT NULL,
  type ENUM('extra_jar', 'pause', 'resume', 'complaint') NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'resolved') NOT NULL DEFAULT 'pending',
  date DATE NULL,
  jars INT NULL,
  from_date DATE NULL,
  to_date DATE NULL,
  topic VARCHAR(60) NULL,
  message VARCHAR(500) NULL,
  admin_note VARCHAR(300) NULL,
  handled_by INT UNSIGNED NULL,
  handled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_request_customer (customer_id, created_at),
  KEY ix_request_status (status, created_at),
  CONSTRAINT fk_request_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(12) NOT NULL,
  kind ENUM('delivery', 'bill', 'payment', 'request', 'offer', 'info') NOT NULL,
  title VARCHAR(120) NOT NULL,
  body VARCHAR(500) NOT NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_notification_customer (customer_id, created_at),
  CONSTRAINT fk_notification_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enquiries (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  mobile VARCHAR(10) NOT NULL,
  address VARCHAR(255) NOT NULL,
  area VARCHAR(80) NULL,
  product ENUM('jar', 'camper') NOT NULL DEFAULT 'jar',
  jars_per_day TINYINT UNSIGNED NOT NULL DEFAULT 1,
  schedule ENUM('daily', 'alternate', 'weekdays') NOT NULL DEFAULT 'daily',
  message VARCHAR(500) NULL,
  source ENUM('app', 'website') NOT NULL DEFAULT 'app',
  status ENUM('new', 'contacted', 'converted', 'closed') NOT NULL DEFAULT 'new',
  customer_id VARCHAR(12) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_enquiry_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS otp_codes (
  mobile VARCHAR(10) NOT NULL PRIMARY KEY,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jars bought, damaged or lost (stock at plant = bought − damaged − lost − with customers).
CREATE TABLE IF NOT EXISTS jar_stock (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type ENUM('purchase', 'damaged', 'lost') NOT NULL,
  qty INT NOT NULL,
  note VARCHAR(255) NULL,
  admin_id INT UNSIGNED NULL,
  date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every admin and delivery boy action.
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_type ENUM('admin', 'delivery', 'customer', 'system') NOT NULL,
  actor_id VARCHAR(20) NULL,
  actor_name VARCHAR(80) NOT NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NULL,
  entity_id VARCHAR(40) NULL,
  details TEXT NULL, -- JSON
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_activity_time (created_at),
  KEY ix_activity_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Scheduled jobs that already ran (monthly bill notices, backups).
CREATE TABLE IF NOT EXISTS job_runs (
  job VARCHAR(40) NOT NULL,
  period VARCHAR(20) NOT NULL,
  ran_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (job, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Orders for weddings, parties and other events: customer orders → admin assigns a delivery boy → delivered.
-- Delivered orders are added to the bill of the month of the event.
CREATE TABLE IF NOT EXISTS event_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(12) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  event_date DATE NOT NULL,
  delivery_time VARCHAR(5) NOT NULL, -- 'HH:MM'
  product ENUM('jar', 'camper') NOT NULL DEFAULT 'jar',
  quantity INT NOT NULL,
  rate_per_jar DECIMAL(8, 2) NOT NULL,
  address VARCHAR(255) NOT NULL,
  contact_name VARCHAR(100) NULL,
  contact_mobile VARCHAR(10) NULL,
  notes VARCHAR(500) NULL,
  status ENUM('pending', 'assigned', 'delivered', 'cancelled', 'rejected') NOT NULL DEFAULT 'pending',
  delivery_boy_id INT UNSIGNED NULL,
  admin_note VARCHAR(300) NULL,
  assigned_at DATETIME(3) NULL,
  jars_delivered INT NULL,
  empties_collected INT NOT NULL DEFAULT 0,
  delivered_at DATETIME(3) NULL,
  delivered_by_name VARCHAR(80) NULL,
  remarks VARCHAR(300) NULL,
  created_by ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_event_status (status, event_date),
  KEY ix_event_boy (delivery_boy_id, event_date),
  KEY ix_event_customer (customer_id, created_at),
  CONSTRAINT fk_event_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_event_boy FOREIGN KEY (delivery_boy_id) REFERENCES delivery_boys (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Razorpay online payments (Payment Links). A paid link becomes a row in `payments` (mode 'online').
CREATE TABLE IF NOT EXISTS online_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(12) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  purpose ENUM('dues', 'event_order') NOT NULL DEFAULT 'dues',
  event_order_id BIGINT UNSIGNED NULL,
  reference_id VARCHAR(40) NOT NULL,
  link_id VARCHAR(40) NULL,
  short_url VARCHAR(255) NULL,
  return_url VARCHAR(255) NULL,
  status ENUM('created', 'paid', 'expired', 'cancelled') NOT NULL DEFAULT 'created',
  razorpay_payment_id VARCHAR(40) NULL,
  method VARCHAR(20) NULL,
  payment_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_online_ref (reference_id),
  UNIQUE KEY uq_online_link (link_id),
  KEY ix_online_customer (customer_id, created_at),
  CONSTRAINT fk_online_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phones that receive push notifications (Expo push tokens).
CREATE TABLE IF NOT EXISTS push_tokens (
  token VARCHAR(255) NOT NULL PRIMARY KEY,
  owner_type ENUM('customer', 'delivery') NOT NULL,
  owner_id VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_push_owner (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
