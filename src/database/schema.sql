-- RIQS Membership Registry - Consolidated Database DDL Schema
-- Designed for enterprise auditability, security, and progression tracking.

-- Cleanup existing tables if running migrations to overwrite (for fresh setups)
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS document_versions CASCADE;
DROP TABLE IF EXISTS uploaded_documents CASCADE;
DROP TABLE IF EXISTS firm_shareholders CASCADE;
DROP TABLE IF EXISTS mentorship_assignments CASCADE;
DROP TABLE IF EXISTS student_association_records CASCADE;
DROP TABLE IF EXISTS education_records CASCADE;
DROP TABLE IF EXISTS apc_assessments CASCADE;
DROP TABLE IF EXISTS application_status_history CASCADE;
DROP TABLE IF EXISTS financial_transactions CASCADE;
DROP TABLE IF EXISTS applications CASCADE;
DROP TABLE IF EXISTS members CASCADE;
DROP TABLE IF EXISTS membership_categories CASCADE;

DROP TYPE IF EXISTS practice_location_enum CASCADE;
DROP TYPE IF EXISTS entity_type_enum CASCADE;
DROP TYPE IF EXISTS application_status_enum CASCADE;
DROP TYPE IF EXISTS member_class_enum CASCADE;
DROP TYPE IF EXISTS apc_status_enum CASCADE;
DROP TYPE IF EXISTS transaction_type_enum CASCADE;
DROP TYPE IF EXISTS payment_method_enum CASCADE;
DROP TYPE IF EXISTS transaction_status_enum CASCADE;

-- Core Enum Definitions
CREATE TYPE practice_location_enum AS ENUM ('Local', 'Foreign');
CREATE TYPE entity_type_enum AS ENUM ('Individual', 'Firm');
CREATE TYPE application_status_enum AS ENUM ('Draft', 'Pending', 'Correction Required', 'Approved', 'Rejected');
CREATE TYPE member_class_enum AS ENUM ('Student', 'Graduate', 'Technologist', 'Associate', 'Visiting', 'Corporate', 'Fellow', 'Life', 'Honorary');
CREATE TYPE apc_status_enum AS ENUM ('Scheduled', 'Attended', 'Passed', 'Failed', 'No Show');
CREATE TYPE transaction_type_enum AS ENUM ('Processing_Fee', 'First_Year_Fee', 'Annual_Renewal', 'Stamp_Fee', 'APC_Fee');
CREATE TYPE payment_method_enum AS ENUM ('MTN_Momo', 'Bank_Transfer', 'Card_Payment', 'Manual_Cash');
CREATE TYPE transaction_status_enum AS ENUM ('Pending_Verification', 'Cleared', 'Failed', 'Refunded');

-- 1. Dynamic Categories & Fee Configurations Configuration
CREATE TABLE membership_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location practice_location_enum NOT NULL,
    entity_type entity_type_enum NOT NULL,
    category_name VARCHAR(100) UNIQUE NOT NULL,
    category_code VARCHAR(10) NOT NULL, -- 'GQST', 'GQS', 'QST', 'PQS', 'FIRM'
    processing_fee DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'RWF', -- 'RWF' or 'USD'
    first_year_fee DECIMAL(12,2) NOT NULL,
    annual_renewal_fee DECIMAL(12,2) NOT NULL,
    stamp_fee DECIMAL(12,2) DEFAULT 0.00
);

-- 2. Members (Core Profiles)
CREATE TABLE members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    date_of_birth DATE,
    gender VARCHAR(20),
    nationality VARCHAR(100),
    national_id_or_passport VARCHAR(100),
    residency_address TEXT,
    work_address TEXT,
    years_in_profession INT DEFAULT 0,
    country_of_origin VARCHAR(100),
    membership_id VARCHAR(100) UNIQUE, -- Generated on Approve: RIQS-[YEAR]-[CODE]-[SEQUENCE]
    membership_class member_class_enum DEFAULT 'Student',
    training_tracking_number VARCHAR(100) UNIQUE, -- Generated on 1st Yr Fee Payment
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Applications
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    practice_location practice_location_enum NOT NULL,
    entity_type entity_type_enum NOT NULL,
    category_id UUID NOT NULL REFERENCES membership_categories(id),
    status application_status_enum DEFAULT 'Draft',
    is_employed BOOLEAN DEFAULT FALSE,
    current_employer VARCHAR(255),
    job_title VARCHAR(100),
    prev_employer VARCHAR(255),
    prev_job_title VARCHAR(100),
    assigned_reviewer_id UUID, -- References Admin users (in auth.users or members table)
    submitted_at TIMESTAMP WITH TIME ZONE,
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Education Records (1:N for Individuals)
CREATE TABLE education_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    institution VARCHAR(255) NOT NULL,
    qualification_type VARCHAR(100) NOT NULL, -- 'Diploma', 'Bachelor', 'Master', etc.
    field_of_study VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Student Association Status Records (1:1 for Graduates)
CREATE TABLE student_association_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID UNIQUE NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    association_name VARCHAR(255) NOT NULL,
    membership_number VARCHAR(100) NOT NULL,
    registration_date DATE NOT NULL,
    active_years INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Mentorship Structured Training Assignments
CREATE TABLE mentorship_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID UNIQUE NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    mentor_name VARCHAR(255),
    mentor_qualification VARCHAR(100),
    mentor_class VARCHAR(100),
    mentor_registration_number VARCHAR(100),
    mentor_employer VARCHAR(255),
    mentor_contact VARCHAR(255),
    is_self_assigned BOOLEAN DEFAULT TRUE,
    requested_institutional_assignment BOOLEAN DEFAULT FALSE,
    preferred_practice_areas TEXT[], -- cost planning, MEP, BOQ etc.
    completed_duration_months INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Firm Shareholders (1:N for Firms)
CREATE TABLE firm_shareholders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    citizenship VARCHAR(100) DEFAULT 'Rwandan',
    shareholding_percentage DECIMAL(5,2) NOT NULL CHECK (shareholding_percentage > 0 AND shareholding_percentage <= 100),
    riqs_membership_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Uploaded Documents
CREATE TABLE uploaded_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    document_type VARCHAR(100) NOT NULL, -- 'Degree', 'PassportPhoto', 'TaxClearance', etc.
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL, -- Private S3/Supabase path
    file_size_bytes INT NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. Document Versions (For correction audit trails)
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    document_type VARCHAR(100) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    file_size_bytes INT NOT NULL,
    version_number INT NOT NULL DEFAULT 1,
    uploaded_by_email VARCHAR(255) NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. APC Assessment Lifecycle
CREATE TABLE apc_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    assessment_date DATE NOT NULL,
    panel_chair_name VARCHAR(255) NOT NULL,
    examiner_1_name VARCHAR(255) NOT NULL,
    examiner_2_name VARCHAR(255) NOT NULL,
    status apc_status_enum DEFAULT 'Scheduled',
    score_percentage DECIMAL(5,2),
    assessment_notes TEXT,
    stamp_fee_paid BOOLEAN DEFAULT FALSE,
    license_issued BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Application Status History (Timeline Notes)
CREATE TABLE application_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    changed_by_email VARCHAR(255) NOT NULL,
    old_status application_status_enum,
    new_status application_status_enum NOT NULL,
    reviewer_notes TEXT, -- Stores correction required notes or rejection reasons
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 12. Double-Entry Financial Transactions Ledger
CREATE TABLE financial_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
    amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) NOT NULL, -- 'RWF' or 'USD'
    tx_type transaction_type_enum NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_reference VARCHAR(255) UNIQUE NOT NULL, -- Transaction message or bank ref
    status transaction_status_enum DEFAULT 'Pending_Verification',
    verified_by_email VARCHAR(255),
    rejection_reason TEXT,
    invoice_url TEXT,
    receipt_url TEXT,
    cleared_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. Audit Trail Logs (Immutable log stream)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    action_by_email VARCHAR(255) NOT NULL,
    action_type VARCHAR(100) NOT NULL, -- 'APPROVE', 'FLAG', 'REJECT', 'NAME_EDIT'
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Performance Database Indexes
CREATE INDEX idx_members_membership_id ON members(membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_assigned_reviewer ON applications(assigned_reviewer_id) WHERE assigned_reviewer_id IS NOT NULL;
CREATE INDEX idx_doc_versions_lookup ON document_versions(application_id, document_type);
CREATE INDEX idx_financial_tx_ref ON financial_transactions(transaction_reference);
CREATE INDEX idx_education_app ON education_records(application_id);

-- Dynamic Category Fees Configuration Data Seeds (Reviewed Version)
INSERT INTO membership_categories (location, entity_type, category_name, category_code, processing_fee, currency, first_year_fee, annual_renewal_fee, stamp_fee) VALUES
-- Local Individuals
('Local', 'Individual', 'Graduate Quantity Surveying Technologist (Route 1)', 'GQST', 10000.00, 'RWF', 50000.00, 70000.00, 0.00),
('Local', 'Individual', 'Graduate Quantity Surveyor (Route 2)', 'GQS', 10000.00, 'RWF', 50000.00, 100000.00, 50000.00),
('Local', 'Individual', 'Quantity Surveying Technologist (Route 3)', 'QST', 10000.00, 'RWF', 0.00, 100000.00, 0.00),
('Local', 'Individual', 'Professional Quantity Surveyor (Route 4)', 'PQS', 10000.00, 'RWF', 0.00, 200000.00, 50000.00),
-- Foreign Individuals
('Foreign', 'Individual', 'Foreign Quantity Surveying Technologist', 'FQST', 30.00, 'USD', 100.00, 100.00, 0.00),
('Foreign', 'Individual', 'Foreign Professional Quantity Surveyor', 'FPQS', 50.00, 'USD', 200.00, 200.00, 0.00),
-- Local Firms
('Local', 'Firm', 'Local Small Firm (<50M Rwf)', 'LF-SM', 50000.00, 'RWF', 300000.00, 300000.00, 0.00),
('Local', 'Firm', 'Local Medium Firm (50-100M Rwf)', 'LF-MD', 100000.00, 'RWF', 500000.00, 500000.00, 0.00),
('Local', 'Firm', 'Local Large Firm (>100M Rwf)', 'LF-LG', 200000.00, 'RWF', 1000000.00, 1000000.00, 0.00),
-- Foreign Firms
('Foreign', 'Firm', 'Foreign Small Firm (<100K USD)', 'FF-SM', 100.00, 'USD', 1000.00, 1000.00, 0.00),
('Foreign', 'Firm', 'Foreign Medium Firm (100-500K USD)', 'FF-MD', 200.00, 'USD', 2000.00, 2000.00, 0.00),
('Foreign', 'Firm', 'Foreign Large Firm (>500K USD)', 'FF-LG', 400.00, 'USD', 3000.00, 3000.00, 0.00);
