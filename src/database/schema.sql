-- Dynamic Category Fees Configuration Data Seeds (Reviewed Version)
INSERT INTO membership_categories (location, entity_type, category_name, category_code, processing_fee, currency, first_year_fee, annual_renewal_fee, stamp_fee) VALUES
-- Local Individuals
('Rwandan', 'Individual', 'Graduate Quantity Surveying Technologist (Route 1)', 'GQST', 10000.00, 'RWF', 50000.00, 70000.00, 0.00),
('Rwandan', 'Individual', 'Graduate Quantity Surveyor (Route 2)', 'GQS', 10000.00, 'RWF', 50000.00, 100000.00, 50000.00),
('Rwandan', 'Individual', 'Quantity Surveying Technologist (Route 3)', 'QST', 10000.00, 'RWF', 0.00, 100000.00, 0.00),
('Rwandan', 'Individual', 'Professional Quantity Surveyor (Route 4)', 'PQS', 10000.00, 'RWF', 0.00, 200000.00, 50000.00),
-- Foreign Individuals
('Non_Rwandan', 'Individual', 'Foreign Quantity Surveying Technologist', 'FQST', 30.00, 'USD', 100.00, 100.00, 0.00),
('Non_Rwandan', 'Individual', 'Foreign Professional Quantity Surveyor', 'FPQS', 50.00, 'USD', 200.00, 200.00, 0.00),
-- Local Firms
('Rwandan', 'Firm', 'Local Small Firm (<50M Rwf)', 'LF-SM', 50000.00, 'RWF', 300000.00, 300000.00, 0.00),
('Rwandan', 'Firm', 'Local Medium Firm (50-100M Rwf)', 'LF-MD', 100000.00, 'RWF', 500000.00, 500000.00, 0.00),
('Rwandan', 'Firm', 'Local Large Firm (>100M Rwf)', 'LF-LG', 200000.00, 'RWF', 1000000.00, 1000000.00, 0.00),
-- Foreign Firms
('Non_Rwandan', 'Firm', 'Foreign Small Firm (<100K USD)', 'FF-SM', 100.00, 'USD', 1000.00, 1000.00, 0.00),
('Non_Rwandan', 'Firm', 'Foreign Medium Firm (100-500K USD)', 'FF-MD', 200.00, 'USD', 2000.00, 2000.00, 0.00),
('Non_Rwandan', 'Firm', 'Foreign Large Firm (>500K USD)', 'FF-LG', 400.00, 'USD', 3000.00, 3000.00, 0.00)
ON CONFLICT (category_name) DO NOTHING;

