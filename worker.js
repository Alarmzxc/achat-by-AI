// worker.js
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        };

        if (method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders, ...headers },
        });

        const handleRequest = async () => {
            const path = url.pathname;

            // 认证和注册
            if (path === '/api/auth' && method === 'POST') {
                const { username, password } = await request.json();
                if (!username || !password) return jsonResponse({ error: '用户名和密码不能为空' }, 400);

                const existingUser = await env.CHAT_KV.get(`user:${username}`);
                const hashedPassword = await hashPassword(password);

                if (existingUser) {
                    // 登录
                    const user = JSON.parse(existingUser);
                    if (await verifyPassword(password, user.password)) {
                        await env.CHAT_KV.put(`status:${username}`, 'online', { expirationTtl: 300 });
                        return jsonResponse({ success: true, message: '登录成功' });
                    }
                    return jsonResponse({ error: '用户名或密码错误' }, 401);
                } else {
                    // 注册
                    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
                        return jsonResponse({ error: '用户名格式不正确' }, 400);
                    }
                    await env.CHAT_KV.put(`user:${username}`, JSON.stringify({ username, password: hashedPassword }));
                    await env.CHAT_KV.put(`status:${username}`, 'online', { expirationTtl: 300 });
                    return jsonResponse({ success: true, message: '注册成功' });
                }
            }

            // 获取在线用户
            if (path === '/api/users' && method === 'GET') {
                const list = await env.CHAT_KV.list({ prefix: 'status:' });
                const users = list.keys.map(key => key.name.substring(7));
                return jsonResponse(users);
            }

            // 发送消息
            if (path === '/api/messages' && method === 'POST') {
                const { sender, receiver, content } = await request.json();
                if (!sender || !receiver || !content) {
                    return jsonResponse({ error: '消息内容不完整' }, 400);
                }

                const timestamp = Date.now();
                const message = { id: `${sender}-${timestamp}`, sender, content, timestamp };
                const dayKey = `messages:${receiver}:${new Date().toISOString().split('T')[0]}`;
                let existingMessages = JSON.parse(await env.CHAT_KV.get(dayKey) || '[]');
                existingMessages.push(message);
                await env.CHAT_KV.put(dayKey, JSON.stringify(existingMessages));
                return jsonResponse({ success: true, message: '消息发送成功' }, 201);
            }

            // 获取消息
            if (path === '/api/messages' && method === 'GET') {
                const { room } = Object.fromEntries(url.searchParams.entries());
                const dayKey = `messages:${room}:${new Date().toISOString().split('T')[0]}`;
                const messages = JSON.parse(await env.CHAT_KV.get(dayKey) || '[]');
                return jsonResponse(messages);
            }

            // 用户离线
            if (path === '/api/offline' && method === 'POST') {
                const { username } = await request.json();
                if (username) {
                    await env.CHAT_KV.delete(`status:${username}`);
                }
                return jsonResponse({ success: true });
            }

            return new Response('Not Found', { status: 404, headers: corsHeaders });
        };

        try {
            return await handleRequest();
        } catch (e) {
            console.error(e);
            return jsonResponse({ error: '服务器内部错误' }, 500);
        }
    }
};

// 密码哈希辅助函数
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, storedHash) {
    const currentHash = await hashPassword(password);
    return currentHash === storedHash;
}