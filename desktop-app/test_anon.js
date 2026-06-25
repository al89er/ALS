const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pvutxjfkskzgccawfibu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dXR4amZrc2t6Z2NjYXdmaWJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNTY4OTMsImV4cCI6MjA5NzgzMjg5M30.FtyD9_XkLKUlBFgt5_I1cZZFhxFLRRpi9yAUbCxDJgw';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function runTest() {
  console.log("Fetching logs with Anon Key...");
  const { data: fetchResult, error: fetchError } = await supabase.from('logs').select('*');
  
  if (fetchError) {
    console.error("FETCH ERROR:", JSON.stringify(fetchError, null, 2));
  } else {
    console.log("FETCH SUCCESS. Total logs:", fetchResult.length);
    console.log("First log:", fetchResult[0]);
  }
}

runTest();
