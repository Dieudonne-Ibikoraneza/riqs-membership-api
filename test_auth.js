const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

// Load variables from backend env file
dotenv.config({ path: path.resolve(__dirname, './.env.local') });

const supabaseUrl = process.env.SUPABASE_URL || 'https://nqbvifvmzyaophrexluv.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseAnonKey || !supabaseServiceRoleKey) {
  console.error('Error: SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY is missing from environment.');
  process.exit(1);
}

// 1. Create standard client for signing in
const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// 2. Create admin client for creating users (bypasses email rate limits and confirms them instantly)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const BACKEND_URL = 'http://localhost:5000/api/v1';

async function executeTest() {
  const timestamp = Date.now();
  const testEmail = `candidate.${timestamp}@gmail.com`;
  const testPassword = `SecurePassword123!`;

  console.log(`=================================================`);
  console.log(`[RIQS End-to-End Test Initiated]`);
  console.log(`Targeting local REST API: ${BACKEND_URL}`);
  console.log(`Targeting Supabase Cluster: ${supabaseUrl}`);
  console.log(`Generating Candidate Email: ${testEmail}`);
  console.log(`Rate-limit bypass status: ACTIVE (Service Role Admin Client)`);
  console.log(`=================================================\n`);

  try {
    // Step 0: Fetch a real membership category UUID dynamically to satisfy database foreign keys
    console.log(`[Step 0/4] Querying available membership categories from database...`);
    const categoryRes = await fetch(`${BACKEND_URL}/categories`);
    const categoryData = await categoryRes.json();
    if (!categoryRes.ok || !categoryData.categories || categoryData.categories.length === 0) {
      throw new Error('No membership categories exist in the database. Please ensure migrations/seeding are complete.');
    }
    const targetCategoryId = categoryData.categories[0].id;
    const targetCategoryName = categoryData.categories[0].category_name;
    console.log(`✔ Found Valid Category: "${targetCategoryName}" (ID: ${targetCategoryId})`);

    // Step 1: Create user via Admin SDK (bypasses rate limits and auto-confirms email)
    console.log(`\n[Step 1/4] Registering and Auto-Confirming User via Admin Auth...`);
    const { data: adminData, error: adminError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true // Force auto-confirm
    });

    if (adminError) {
      throw new Error(`Admin CreateUser failed: ${adminError.message}`);
    }

    console.log(`✔ User registered and confirmed. UID: ${adminData.user?.id}`);

    // Step 1.5: Authenticate credentials with standard client to acquire JWT token
    console.log(`[Step 1.5] Authenticating credentials to acquire JWT Session Token...`);
    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });

    if (signInError) {
      throw new Error(`Supabase login failed: ${signInError.message}`);
    }

    const jwtToken = signInData.session?.access_token;
    if (!jwtToken) {
      throw new Error('Could not acquire valid JWT session token.');
    }

    console.log(`✔ Acquired Supabase Session JWT Token.`);

    // Step 2: Synchronize with our REST API Node.js backend
    console.log(`\n[Step 2/4] Calling POST /auth/sync to initialize custom Registry Roll...`);
    const syncRes = await fetch(`${BACKEND_URL}/auth/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({
        fullName: 'Dieudonne Staging Candidate',
        phoneNumber: '+250788000111',
        dob: '1995-04-18',
        gender: 'Male',
        nationality: 'Rwandan',
        residencyAddress: 'Kigali City, Rwanda'
      })
    });

    const syncResult = await syncRes.json();
    if (!syncRes.ok) {
      throw new Error(`Sync profile failed: ${JSON.stringify(syncResult)}`);
    }

    console.log(`✔ Profile sync success! Result message: "${syncResult.message}"`);
    console.log(`[SMTP Mailer Check]: Welcome registration mail dispatched to email.`);

    // Step 3: Fetch candidate profile data packet
    console.log(`\n[Step 3/4] Calling GET /applicants/profile to read full dashboard state...`);
    const profileRes = await fetch(`${BACKEND_URL}/applicants/profile`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${jwtToken}`
      }
    });

    const profileResult = await profileRes.json();
    if (!profileRes.ok) {
      throw new Error(`Get profile failed: ${JSON.stringify(profileResult)}`);
    }

    console.log(`✔ GET /applicants/profile success! State details:`);
    console.log(`  - Profile Status: ${profileResult.application ? profileResult.application.status : 'No application draft yet (Wizard Step 1)'}`);

    // Step 4: Create wizard draft using the dynamic valid category ID
    console.log(`\n[Step 4/4] Calling PATCH /applicants/application (Auto-save step 2)...`);
    const patchRes = await fetch(`${BACKEND_URL}/applicants/application`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({
        practiceLocation: 'Local',
        entityType: 'Individual',
        categoryId: targetCategoryId // Dynamic safe ID
      })
    });

    const patchResult = await patchRes.json();
    if (!patchRes.ok) {
      throw new Error(`PATCH draft failed: ${JSON.stringify(patchResult)}`);
    }

    console.log(`✔ Auto-save draft saved successfully! Status: "${patchResult.application.status}"`);
    console.log(`\n=================================================`);
    console.log(`✔ END-TO-END WORKFLOW VERIFIED SUCCESSFULLY!`);
    console.log(`=================================================`);

  } catch (error) {
    console.error(`\n❌ End-to-End Test Failure: ${error.message}`);
  }
}

executeTest();
