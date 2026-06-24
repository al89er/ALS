import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    // 1. Initialize Supabase Client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. Parse Incoming Telegram Webhook
    const update = await req.json();
    
    // Safety check: ensure it's a message
    if (!update.message || !update.message.text) {
      return new Response(JSON.stringify({ ok: true }), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text.trim().toLowerCase();

    // 3. Security Verification
    const authorizedChatId = Deno.env.get('TELEGRAM_CHAT_ID');
    if (chatId !== authorizedChatId) {
      console.warn(`Unauthorized access attempt from Chat ID: ${chatId}`);
      // Return 200 so Telegram doesn't retry, but we do nothing
      return new Response(JSON.stringify({ ok: true }), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    // 4. Command Routing
    let action = '';
    let replyText = '';

    if (text === '/clockin') {
      action = 'clock_in';
      replyText = 'Command received: Deploying desktop agent for Clock In.';
    } else if (text === '/clockout') {
      action = 'clock_out';
      replyText = 'Command received: Deploying desktop agent for Clock Out.';
    } else {
      replyText = 'Unrecognized command. Use /clockin or /clockout.';
      return new Response(JSON.stringify({
        method: 'sendMessage',
        chat_id: chatId,
        text: replyText
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 5. Database Insertion
    const { error } = await supabase
      .from('commands')
      .insert([{ action: action, status: 'pending' }]);

    if (error) {
      console.error('Database insertion error:', error);
      replyText = 'Error: Failed to insert command into the database.';
    }

    // 6. Return Telegram Reply Payload
    return new Response(JSON.stringify({
      method: 'sendMessage',
      chat_id: chatId,
      text: replyText
    }), { 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (error) {
    console.error('Edge function error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" } 
    });
  }
});
