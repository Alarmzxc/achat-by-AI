export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        let path = url.pathname;
        const method = request.method;
        const now = Date.now();

        // CORS配置
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        };

        // 处理预检请求
        if (method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // 帮助函数，用于返回JSON响应
        function jsonResponse(data, status = 200, headers = {}) {
            return new Response(JSON.stringify(data), {
                status,
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                    ...headers,
                },
            });
        }

        try {
            // 用户注册
            if (path === '/api/register' && method === 'POST') {
                const { username, password } = await request.json();
                if (!username || !password) {
                    return jsonResponse({ error: '用户名和密码不能为空' }, 400);
                }
                if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
                    return jsonResponse({ error: '用户名需为2-20位字母数字下划线' }, 400);
                }
                if (password.length < 64) {
                    return jsonResponse({ error: '密码格式错误' }, 400);
                }

                const userKey = `user:${username}`;
                const existingUser = await env.CHAT_KV.get(userKey);
                if (existingUser) {
                    return jsonResponse({ error: '用户名已存在' }, 409);
                }

                const userData = {
                    password,
                    created: now,
                    lastActive: now
                };
                
                await env.CHAT_KV.put(userKey, JSON.stringify(userData));
                return jsonResponse({ success: true }, 201);
            }

            // 用户登录
            if (path === '/api/login' && method === 'POST') {
                const { username, password } = await request.json();
                if (!username || !password) {
                    return jsonResponse({ error: '用户名和密码不能为空' }, 400);
                }
                
                const userKey = `user:${username}`;
                const userData = await env.CHAT_KV.get(userKey, 'json');

                if (!userData || userData.password !== password) {
                    return jsonResponse({ error: '用户名或密码错误' }, 401);
                }

                userData.lastActive = now;
                await env.CHAT_KV.put(userKey, JSON.stringify(userData));

                return jsonResponse({ success: true }, 200);
            }

            // 更新活跃状态
            if (path === '/api/active' && method === 'POST') {
                const { username } = await request.json();
                if (!username) {
                    return jsonResponse({ error: '用户名不能为空' }, 400);
                }
                await env.CHAT_KV.put(`active:${username}`, now.toString(), {
                    expirationTtl: 300
                });
                
                return jsonResponse({ success: true }, 200);
            }

            // 获取活跃用户列表
            if (path === '/api/get-active-users' && method === 'GET') {
                const keys = await env.CHAT_KV.list({ prefix: 'active:' });
                const users = keys.keys.map(key => key.name.replace('active:', ''));
                return jsonResponse(users);
            }

            // 发送消息
            if (path === '/api/send' && method === 'POST') {
                const { from, message, to } = await request.json();
                
                if (!from || !message) {
                    return jsonResponse({ error: '发件人和消息内容不能为空' }, 400);
                }
                
                const lastActive = await env.CHAT_KV.get(`active:${from}`);
                if (!lastActive) {
                    return jsonResponse({ error: '用户未登录' }, 403);
                }
                
                await env.CHAT_KV.put(`active:${from}`, now.toString(), {
                    expirationTtl: 300
                });
                
                let messageRoomId;
                if (to) {
                    // 私聊消息，生成唯一的房间ID
                    const sortedUsers = [from, to].sort();
                    messageRoomId = `private:${sortedUsers[0]}_${sortedUsers[1]}`;
                } else {
                    messageRoomId = 'public';
                }

                const newMessage = {
                    id: `${from}_${now}_${Math.random().toString(36).substr(2, 9)}`,
                    from,
                    to: to || null,
                    roomId: messageRoomId,
                    message: message.slice(0, 1000),
                    time: now
                };

                const dayKey = `messages:${messageRoomId}:${new Date(now).toISOString().split('T')[0]}`;

                let existingMessages = await env.CHAT_KV.get(dayKey, 'json') || [];
                existingMessages.push(newMessage);
                const trimmedMessages = existingMessages.slice(-2000);

                await env.CHAT_KV.put(dayKey, JSON.stringify(trimmedMessages), {
                    expirationTtl: 90 * 24 * 60 * 60
                });

                return jsonResponse({ success: true }, 201);
            }
            
            // 获取消息 (已修改为支持增量拉取和多房间)
            if (path === '/api/get-messages' && method === 'GET') {
                const roomIds = url.searchParams.getAll('roomIds');
                
                const allMessages = {};
                for (const roomId of roomIds) {
                    const lastId = url.searchParams.get(`lastId_${roomId}`);
                    
                    const today = new Date(now).toISOString().split('T')[0];
                    const dayKey = `messages:${roomId}:${today}`;

                    let existingMessages = await env.CHAT_KV.get(dayKey, 'json') || [];

                    let newMessages = existingMessages;
                    if (lastId) {
                        const lastIndex = existingMessages.findIndex(msg => msg.id === lastId);
                        if (lastIndex !== -1) {
                            newMessages = existingMessages.slice(lastIndex + 1);
                        }
                    }
                    allMessages[roomId] = newMessages;
                }

                return jsonResponse(allMessages);
            }
        } catch (e) {
            console.error(e);
            return jsonResponse({ error: '服务器内部错误' }, 500);
        }

        // 默认响应
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
};