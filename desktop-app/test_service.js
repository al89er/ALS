require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.log("No Supabase URL found in ../.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runTest() {
  console.log("Inserting test log with Service Role Key...");
  const { data: insertData, error: insertError } = await supabase.from('logs').insert({
    action: 'test',
    status: 'success',
    message: 'This is a test log from test script'
  }).select();
  
  if (insertError) {
    console.error("INSERT ERROR:", JSON.stringify(insertError, null, 2));
  } else {
    console.log("INSERT SUCCESS:", insertData);
  }
}

runTest();
