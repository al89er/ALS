require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function runTest() {
  console.log("Inserting test log...");
  const { data: insertData, error: insertError } = await supabase.from('logs').insert({
    action: 'test',
    status: 'success',
    message: 'This is a test log'
  }).select();
  
  if (insertError) {
    console.error("INSERT ERROR:", insertError);
  } else {
    console.log("INSERT SUCCESS:", insertData);
  }
  
  console.log("Fetching logs...");
  const { data: fetchResult, error: fetchError } = await supabase.from('logs').select('*');
  
  if (fetchError) {
    console.error("FETCH ERROR:", fetchError);
  } else {
    console.log("FETCH SUCCESS. Total logs:", fetchResult.length);
  }
}

runTest();
