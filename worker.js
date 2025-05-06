// worker.js

// Allowed origin for CORS and security check
const ALLOWED_ORIGIN = 'https://llm.alarmandcxz.dpdns.org';

// API Endpoints - Using OpenRouter's OpenAI-compatible endpoint
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
// Direct Gemini API Base (if needed, but OpenRouter often includes Gemini)
// const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Supported models and their API source/key
const MODELS = {
    // OpenRouter models (including those that wrap Gemini)
    'google/gemini-pro': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    'google/gemini-pro-1.5-flash': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    'google/gemini-pro-1.5-pro': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    'openai/gpt-3.5-turbo': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    'openai/gpt-4-turbo': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    'openai/gpt-4o': { api: 'openrouter', key_env: 'OPENROUTER_API_KEY' },
    // Add other models you want to support via OpenRouter here...

    // Direct Gemini models (if you want to bypass OpenRouter for some)
    // 'gemini-pro': { api: 'gemini', key_env: 'GEMINI_API_KEY' },
    // 'gemini-1.5-pro-latest': { api: 'gemini', key_env: 'GEMINI_API_KEY' },
    // 'gemini-1.5-flash-latest': { api: 'gemini', key_env: 'GEMINI_API_KEY' },
};


addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // --- Security: Origin Check ---
    if (origin !== ALLOWED_ORIGIN) {
        // Respond to OPTIONS preflight request correctly even if origin is wrong
         if (request.method === 'OPTIONS') {
            return handleOptions(request);
         }
        return new Response('Unauthorized origin', { status: 403 });
    }

    // --- CORS Headers ---
    const corsHeaders = {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Allow Content-Type for POST, Authorization if we used it directly (not needed for frontend calls to worker)
        'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    };

    // --- Handle OPTIONS Preflight ---
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // --- Routing ---
    if (url.pathname.startsWith('/api/chat')) {
        if (request.method === 'POST') {
            return handleChatCompletion(request, corsHeaders);
        } else {
            return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
        }
    } else if (url.pathname.startsWith('/api/models')) {
         if (request.method === 'GET') {
             return handleListModels(request, corsHeaders);
         } else {
             return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
         }
    } else {
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
}

// Handles OPTIONS requests for CORS preflight
function handleOptions(request) {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', // Specify headers the client might send
        'Access-Control-Max-Age': '86400', // Cache preflight response for 24 hours
      },
    });
}


async function handleChatCompletion(request, corsHeaders) {
    try {
        const requestBody = await request.json();
        const { model, messages, temperature, max_tokens } = requestBody;

        if (!model || !messages || !Array.isArray(messages)) {
            return new Response('Invalid request body', { status: 400, headers: corsHeaders });
        }

        const modelConfig = MODELS[model];
        if (!modelConfig) {
            return new Response(`Unsupported model: ${model}`, { status: 400, headers: corsHeaders });
        }

        const apiKey = env[modelConfig.key_env]; // Access API key from environment variable

        if (!apiKey) {
             console.error(`API key for ${modelConfig.key_env} is not set.`);
             return new Response(`API key for ${model} is not configured.`, { status: 500, headers: corsHeaders });
        }

        let apiResponse;
        let apiUrl;
        let apiHeaders;
        let apiBody;

        // --- Construct API Request based on Model Config ---
        if (modelConfig.api === 'openrouter') {
            apiUrl = `${OPENROUTER_API_BASE}/chat/completions`;
            apiHeaders = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                // Optional: Include Referer header for OpenRouter tracking
                 'HTTP-Referer': ALLOWED_ORIGIN,
                 'X-Title': 'Simple LLM Chat App on Cloudflare Worker'
            };
            apiBody = JSON.stringify({
                model: model,
                messages: messages,
                temperature: temperature,
                max_tokens: max_tokens,
                // Add other OpenAI-compatible parameters here if needed
                // e.g., top_p, frequency_penalty, presence_penalty, stream: false (or true)
            });
        }
        /*
        // Example for Direct Gemini API (if you choose to implement it)
        else if (modelConfig.api === 'gemini') {
             apiUrl = `${GEMINI_API_BASE}/models/${model}:generateContent`;
             apiHeaders = {
                 'Content-Type': 'application/json',
                 'x-goog-api-key': apiKey, // Gemini uses x-goog-api-key header
             };
             // Convert messages from OpenAI format to Gemini format
             const geminiContents = messages.map(msg => ({
                 role: msg.role === 'user' ? 'user' : 'model', // Gemini uses 'user' and 'model'
                 parts: [{ text: msg.content }]
             }));
             apiBody = JSON.stringify({
                 contents: geminiContents,
                 generationConfig: {
                     temperature: temperature,
                     maxOutputTokens: max_tokens, // Gemini uses maxOutputTokens
                     // Add other Gemini generationConfig parameters here
                 }
             });
        }
        */
        else {
             return new Response(`Unknown API type for model: ${model}`, { status: 500, headers: corsHeaders });
        }


        // --- Fetch from the chosen API ---
        apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: apiHeaders,
            body: apiBody,
        });

        // --- Handle API Response ---
        // Clone the response so we can read the body multiple times (if needed for error logging)
        const apiResponseClone = apiResponse.clone();

        if (!apiResponse.ok) {
            const errorBody = await apiResponseClone.json().catch(() => null); // Try to parse JSON error body
            console.error(`API error ${apiResponse.status} from ${apiUrl}:`, errorBody);

            let errorMessage = 'An error occurred with the language model API.';
            let status = apiResponse.status; // Use the original status code

             // Attempt to extract specific error messages from common API formats
            if (errorBody && errorBody.error && errorBody.error.message) { // OpenAI/OpenRouter format
                errorMessage = `API error: ${errorBody.error.message}`;
                 // Specific check for rate limit / quota
                 if (errorBody.error.type === 'rate_limit_exceeded' || apiResponse.status === 429) {
                     errorMessage = '模型额度可能已用尽或请求频率过高。请稍后再试或检查您的账户。';
                     status = 429; // Force 429 status if it wasn't already
                 } else if (apiResponse.status === 401 || apiResponse.status === 403) {
                      errorMessage = 'API 密钥无效或权限不足。请检查 worker 的环境变量。';
                 }
            } else if (errorBody && errorBody.message) { // Potential other formats (like Gemini direct)
                 errorMessage = `API error: ${errorBody.message}`;
                  if (apiResponse.status === 429) {
                     errorMessage = '模型额度可能已用尽或请求频率过高。请稍后再试或检查您的账户。';
                 } else if (apiResponse.status === 401 || apiResponse.status === 403) {
                      errorMessage = 'API 密钥无效或权限不足。请检查 worker 的环境变量。';
                 }
            } else {
                 // Fallback if body isn't JSON or doesn't have known structure
                 errorMessage = `API error: Status ${apiResponse.status}`;
            }


            // Return a Response object with the error message and appropriate status
            return new Response(JSON.stringify({ error: { message: errorMessage, status: apiResponse.status } }), {
                status: status, // Use the determined status code
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Success: Return the API response body directly to the frontend
        const responseBody = await apiResponse.json();
        return new Response(JSON.stringify(responseBody), {
            status: apiResponse.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("Worker error in handleChatCompletion:", error);
        return new Response(`Internal server error: ${error.message}`, { status: 500, headers: corsHeaders });
    }
}


async function handleListModels(request, corsHeaders) {
    try {
        // Fetch models from OpenRouter's list endpoint
        const openrouterApiKey = env.OPENROUTER_API_KEY;
         if (!openrouterApiKey) {
              console.error("OPENROUTER_API_KEY is not set for fetching models.");
             // Return empty list or an error indicating config issue
             return new Response(JSON.stringify({ error: { message: 'OpenRouter API key is not configured to fetch models.' } }), {
                 status: 500,
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' }
             });
         }

        const modelsUrl = `${OPENROUTER_API_BASE}/models`;
        const apiResponse = await fetch(modelsUrl, {
            headers: {
                'Authorization': `Bearer ${openrouterApiKey}`,
                'Content-Type': 'application/json',
                 'HTTP-Referer': ALLOWED_ORIGIN,
                 'X-Title': 'Simple LLM Chat App on Cloudflare Worker'
            },
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.json().catch(() => null);
             console.error(`Failed to fetch models from OpenRouter ${apiResponse.status}:`, errorBody);
             let errorMessage = `Failed to fetch models from OpenRouter: Status ${apiResponse.status}`;
              if (errorBody && errorBody.message) {
                  errorMessage = `Failed to fetch models from OpenRouter: ${errorBody.message}`;
              } else if (errorBody && errorBody.error && errorBody.error.message) {
                   errorMessage = `Failed to fetch models from OpenRouter: ${errorBody.error.message}`;
              }


             // Return an error response
             return new Response(JSON.stringify({ error: { message: errorMessage } }), {
                 status: apiResponse.status, // Use the status from OpenRouter
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' }
             });
        }

        const data = await apiResponse.json();
        // OpenRouter's /models endpoint returns { data: [ { id: '...', name: '...' }, ... ] }
        const modelsList = data.data || [];

        // Optional: Filter models to only include those defined in our `MODELS` object
        const supportedModels = modelsList.filter(model => MODELS[model.id]);

        // Return the list of supported models to the frontend
        return new Response(JSON.stringify(supportedModels), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("Worker error in handleListModels:", error);
         return new Response(JSON.stringify({ error: { message: `Internal server error fetching models: ${error.message}` } }), {
             status: 500,
             headers: { ...corsHeaders, 'Content-Type': 'application/json' }
         });
    }
}

