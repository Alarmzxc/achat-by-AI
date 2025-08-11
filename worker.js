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

    try {
      // 用户注册
      if (path === '/api/register' && method === 'POST') {
        const { username, password } = await request.json();
        
        // 输入验证
        if (!username || !password) {
          return jsonResponse({ error: '用户名和密码不能为空' }, 400, corsHeaders);
        }
        
        if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
          return jsonResponse({ error: '用户名需为2-20位字母数字下划线' }, 400, corsHeaders);
        }

        if (password.length < 64) { // 前端已hash，至少64字符
          return jsonResponse({ error: '密码格式错误' }, 400, corsHeaders);
        }

        // 检查用户是否存在
        const userKey = `user:${username}`;
        const existingUser = await env.CHAT_KV.get(userKey);
        if (existingUser) {
          return jsonResponse({ error: '用户名已存在' }, 409, corsHeaders);
        }

        // 存储用户信息
        const userData = {
          password,
          created: now,
          lastActive: now
        };
        
        await env.CHAT_KV.put(userKey, JSON.stringify(userData));
        return jsonResponse({ success: true }, 201, corsHeaders);
      }

      // 用户登录
      if (path === '/api/login' && method === 'POST') {
        const { username, password } = await request.json();
        
        if (!username || !password) {
          return jsonResponse({ error: '用户名和密码不能为空' }, 400, corsHeaders);
        }
        
        const userKey = `user:${username}`;
        const userData = await env.CHAT_KV.get(userKey, 'json');

        if (!userData || userData.password !== password) {
          return jsonResponse({ error: '用户名或密码错误' }, 401, corsHeaders);
        }

        // 更新最后活跃时间
        userData.lastActive = now;
        await env.CHAT_KV.put(userKey, JSON.stringify(userData));

        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      // 更新活跃状态
      if (path === '/api/active' && method === 'POST') {
        const { username } = await request.json();
        
        if (!username) {
          return jsonResponse({ error: '用户名不能为空' }, 400, corsHeaders);
        }
        
        // 更新活跃状态（5分钟过期）
        await env.CHAT_KV.put(`active:${username}`, now.toString(), {
          expirationTtl: 300
        });
        
        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      // 发送消息
      if (path === '/api/send' && method === 'POST') {
        const { from, message, to, roomId } = await request.json();
        
        if (!from || !message) {
          return jsonResponse({ error: '发件人和消息内容不能为空' }, 400, corsHeaders);
        }
        
        // 验证用户活跃状态
        const lastActive = await env.CHAT_KV.get(`active:${from}`);
        if (!lastActive) {
          return jsonResponse({ error: '用户未登录' }, 403, corsHeaders);
        }
        
        // 更新活跃状态
        await env.CHAT_KV.put(`active:${from}`, now.toString(), {
          expirationTtl: 300
        });

        // 创建消息对象
        const newMessage = {
          id: `${from}_${now}_${Math.random().toString(36).substr(2, 9)}`,
          from,
          to: to || null,
          roomId: roomId || 'public',
          message: message.slice(0, 1000), // 限制消息长度
          time: now
        };

        // 存储消息到对应房间
        const messageKey = roomId || 'public';
        const dayKey = `messages:${messageKey}:${new Date(now).toISOString().split('T')[0]}`;
        
        // 获取现有消息
        const existingMessages = await env.CHAT_KV.get(dayKey, 'json') || [];
        
        // 添加新消息
        existingMessages.push(newMessage);
        
        // 限制每天每房间最多存储2000条消息
        const trimmedMessages = existingMessages.slice(-2000);
        
        // 保存回KV (保存90天)
        await env.CHAT_KV.put(dayKey, JSON.stringify(trimmedMessages), {
          expirationTtl: 90 * 24 * 60 * 60 // 90天
        });

        // 如果是私聊，创建/更新房间记录
        if (to && to !== from) {
          const roomKey = getRoomKey(from, to);
          const roomInfo = {
            id: roomKey,
            participants: [from, to].sort(),
            lastMessage: {
              content: message.slice(0, 50),
              time: now,
              from: from
            },
            created: now
          };
          
          // 检查房间是否存在
          const existingRoom = await env.CHAT_KV.get(`room:${roomKey}`, 'json');
          if (existingRoom) {
            roomInfo.created = existingRoom.created;
          }
          
          await env.CHAT_KV.put(`room:${roomKey}`, JSON.stringify(roomInfo), {
            expirationTtl: 90 * 24 * 60 * 60 // 90天
          });
        }
        
        return jsonResponse({ success: true, messageId: newMessage.id }, 201, corsHeaders);
      }

      // 获取消息
      if (path === '/api/messages' && method === 'GET') {
        const currentUser = url.searchParams.get('user');
        const roomId = url.searchParams.get('roomId') || 'public';
        
        if (!currentUser) {
          return jsonResponse({ error: '用户未指定' }, 400, corsHeaders);
        }
        
        // 验证房间访问权限
        if (roomId !== 'public') {
          const roomInfo = await env.CHAT_KV.get(`room:${roomId}`, 'json');
          if (!roomInfo || !roomInfo.participants.includes(currentUser)) {
            return jsonResponse({ error: '无权访问该房间' }, 403, corsHeaders);
          }
        }
        
        // 获取最近7天的消息
        const messages = [];
        for (let i = 0; i < 7; i++) {
          const date = new Date(now - i * 86400000).toISOString().split('T')[0];
          const dayKey = `messages:${roomId}:${date}`;
          const dayMessages = await env.CHAT_KV.get(dayKey, 'json') || [];
          messages.push(...dayMessages);
        }

        // 按时间排序
        const sortedMessages = messages.sort((a, b) => a.time - b.time);
        
        // 限制返回200条消息
        const limitedMessages = sortedMessages.slice(-200);
        
        return jsonResponse(limitedMessages, 200, corsHeaders);
      }

      // 获取在线用户
      if (path === '/api/users' && method === 'GET') {
        const keys = await env.CHAT_KV.list({ prefix: 'active:' });
        const users = [];
        
        for (const key of keys.keys) {
          const username = key.name.replace('active:', '');
          users.push(username);
        }

        return jsonResponse(users, 200, corsHeaders);
      }

      // 获取房间列表
      if (path === '/api/rooms' && method === 'GET') {
        const currentUser = url.searchParams.get('user');
        
        if (!currentUser) {
          return jsonResponse({ error: '用户未指定' }, 400, corsHeaders);
        }
        
        const keys = await env.CHAT_KV.list({ prefix: 'room:' });
        const rooms = [];
        
        for (const key of keys.keys) {
          const roomInfo = await env.CHAT_KV.get(key.name, 'json');
          if (roomInfo && roomInfo.participants.includes(currentUser)) {
            // 获取对方用户名
            const otherUser = roomInfo.participants.find(p => p !== currentUser);
            rooms.push({
              ...roomInfo,
              displayName: otherUser,
              unreadCount: 0 // 简化版本不实现未读计数
            });
          }
        }
        
        // 按最后消息时间排序
        rooms.sort((a, b) => (b.lastMessage?.time || 0) - (a.lastMessage?.time || 0));
        
        return jsonResponse(rooms, 200, corsHeaders);
      }

      // 静态文件服务
      if (method === 'GET') {
        // 根路径重定向到首页
        if (path === '/') {
          return new Response(null, {
            status: 302,
            headers: {
              'Location': '/index.html',
              ...corsHeaders
            }
          });
        }
        
        // 根据路径返回对应的HTML文件
        let fileName = '';
        if (path === '/auth.html' || path === '/index.html') {
          fileName = path.substring(1); // 去掉开头的 /
        }
        
        if (fileName) {
          // 这里返回404，因为静态文件将由GitHub Pages或CF Pages提供
          return jsonResponse({ error: '静态文件请通过Pages服务访问' }, 404, corsHeaders);
        }
      }

      return jsonResponse({ error: '路由不存在' }, 404, corsHeaders);

    } catch (error) {
      console.error('Worker错误:', error);
      return jsonResponse({ error: '服务器内部错误' }, 500, corsHeaders);
    }
  }
}

// 生成房间ID的辅助函数
function getRoomKey(user1, user2) {
  return [user1, user2].sort().join('_');
}

// 辅助函数：返回JSON响应
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}