require('dotenv').config();
console.log('DB_HOST:', process.env.DB_HOST);

const express = require('express');
const path = require('path');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const app = express();

// Set up view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Set up session
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
}));

app.use(cookieParser());

// Update this with your actual DB credentials or use dotenv
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
};

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server);

// Socket.IO connection for widget and admin/agent
io.on('connection', (socket) => {
    // Visitor joins a conversation
    socket.on('visitor join', async ({ businessId, visitorId }) => {
        let conversationId;
        try {
            const connection = await mysql.createConnection(dbConfig);
            const [convRows] = await connection.execute(
                'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ?',
                [businessId, visitorId]
            );
            if (convRows.length > 0) {
                conversationId = convRows[0].id;
                socket.data.conversationId = conversationId;
                socket.data.businessId = businessId;
                socket.data.visitorId = visitorId;
                socket.join('conv_' + conversationId);
            }
            await connection.end();
        } catch (err) {}
    });
    // Admin/agent joins a conversation
    socket.on('admin join', ({ businessId, conversationId }) => {
        socket.data.conversationId = conversationId;
        socket.data.businessId = businessId;
        socket.join('conv_' + conversationId);
    });
    // Admin joins a business-wide room for real-time updates
    socket.on('join business', ({ businessId }) => {
        socket.join('business_' + businessId);
    });
    // Visitor sends a message
    socket.on('visitor message', async (data) => {
        const { content } = data;
        let conversationId = socket.data.conversationId;
        let businessId = socket.data.businessId || data.businessId;
        let visitorId = socket.data.visitorId || data.visitorId;
        let isNewConversation = false;
        if (!businessId || !visitorId) return;
        try {
            const connection = await mysql.createConnection(dbConfig);
            // If no conversation, create it now
            if (!conversationId) {
                const [convRows] = await connection.execute(
                    'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ?',
                    [businessId, visitorId]
                );
                if (convRows.length > 0) {
                    conversationId = convRows[0].id;
                } else {
                    const [result] = await connection.execute(
                        'INSERT INTO conversations (business_id, visitor_name, status) VALUES (?, ?, ?)',
                        [businessId, visitorId, 'active']
                    );
                    conversationId = result.insertId;
                    isNewConversation = true;
                }
                socket.data.conversationId = conversationId;
                socket.data.businessId = businessId;
                socket.data.visitorId = visitorId;
                socket.join('conv_' + conversationId);
            }
            await connection.execute(
                'INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())',
                [conversationId, content, 'user', 0]
            );
            await connection.end();
        } catch (err) {}
        // Broadcast to all in the conversation (including admins/agents)
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'user', conversationId, content });
        // Emit to business room for new or updated conversation
        if (isNewConversation) {
            io.to('business_' + businessId).emit('new conversation', { businessId, conversationId });
        } else {
            io.to('business_' + businessId).emit('update conversation', { businessId, conversationId });
        }
    });
    // Admin/agent sends a message
    socket.on('admin message', async (data) => {
        const { businessId, conversationId, content } = data;
        if (!conversationId) return;
        try {
            const connection = await mysql.createConnection(dbConfig);
            await connection.execute(
                'INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())',
                [conversationId, content, 'agent', 0]
            );
            await connection.end();
        } catch (err) {}
        // Broadcast to all in the conversation (including visitor)
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'agent', conversationId, content });
        // Emit to business room for updated conversation
        io.to('business_' + businessId).emit('update conversation', { businessId, conversationId });
    });
});

// Routes
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/register', (req, res) => {
    res.render('register');
});

// Registration (users table)
app.post('/register', async (req, res) => {
    const { email, password, name } = req.body;
    let error;
    if (!email || !password || !name) {
        error = 'All fields are required.';
        return res.render('register', { error });
    }
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check if email already exists
        const [rows] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (rows.length > 0) {
            error = 'Email already exists.';
            await connection.end();
            return res.render('register', { error });
        }
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        // Insert new user
        const [result] = await connection.execute(
            'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
            [email, hashedPassword, name]
        );
        // Get the new user ID
        const userId = result.insertId;
        await connection.end();
        // Auto-login: set session
        req.session.userId = userId;
        req.session.userName = name;
        // Redirect to dashboard
        return res.redirect('/dashboard');
    } catch (err) {
        error = 'Registration failed. Please try again.';
        return res.render('register', { error });
    }
});

// Login (users table)
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    let error;
    if (!email || !password) {
        error = 'All fields are required.';
        return res.render('login', { error });
    }
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
        await connection.end();
        if (rows.length === 0) {
            error = 'Invalid email or password.';
            return res.render('login', { error });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            error = 'Invalid email or password.';
            return res.render('login', { error });
        }
        // Set session
        req.session.userId = user.id;
        req.session.userName = user.name;
        res.redirect('/dashboard');
    } catch (err) {
        error = 'Login failed. Please try again.';
        return res.render('login', { error });
    }
});

// Middleware to protect routes
function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
}

// Dashboard route (protected, now all-in-one dashboard)
app.get('/dashboard', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    let businesses = [];
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [owned] = await connection.execute(
            'SELECT * FROM businesses WHERE owner_user_id = ?', [userId]
        );
        const [member] = await connection.execute(
            `SELECT b.* FROM businesses b
             JOIN business_users bu ON bu.business_id = b.id
             WHERE bu.user_id = ?`, [userId]
        );
        businesses = [...owned];
        member.forEach(mb => {
            if (!businesses.find(b => b.id === mb.id)) {
                businesses.push(mb);
            }
        });
        await connection.end();
    } catch (err) {
        businesses = [];
    }
    if (businesses.length === 0) {
        // Render add business form directly
        return res.render('add_business');
    }
    let selectedBusiness = null;
    let selectedId = req.query.business ? parseInt(req.query.business) : null;
    if (businesses.length > 0) {
        if (selectedId && businesses.find(b => b.id === selectedId)) {
            selectedBusiness = businesses.find(b => b.id === selectedId);
        } else {
            selectedBusiness = businesses[0];
        }
    }
    res.render('dashboard', { businesses, selectedBusiness, host: req.headers.host });
});

// Add pretty URL route for dashboard by business ID
app.get('/dashboard/:businessId', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = parseInt(req.params.businessId, 10);
    let businesses = [];
    let selectedBusiness = null;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [owned] = await connection.execute(
            'SELECT * FROM businesses WHERE owner_user_id = ?', [userId]
        );
        const [member] = await connection.execute(
            `SELECT b.* FROM businesses b
             JOIN business_users bu ON bu.business_id = b.id
             WHERE bu.user_id = ?`, [userId]
        );
        businesses = [...owned];
        member.forEach(mb => {
            if (!businesses.find(b => b.id === mb.id)) {
                businesses.push(mb);
            }
        });
        // Find business by ID
        selectedBusiness = businesses.find(b => b.id === businessId);
        await connection.end();
    } catch (err) {
        businesses = [];
        selectedBusiness = null;
    }
    if (businesses.length === 0) {
        // Render add business form directly
        return res.render('add_business');
    }
    res.render('dashboard', { businesses, selectedBusiness, host: req.headers.host });
});

// Add business POST route (matches add_business.ejs form)
app.post('/business/add', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const { name, widget_header_color, widget_h1_color, widget_button_color, widget_visitor_message_color, widget_quick_replies } = req.body;
    if (!name) {
        return res.redirect('/dashboard');
    }
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Insert business with widget settings
        const [result] = await connection.execute(
            'INSERT INTO businesses (name, owner_user_id, widget_header_color, widget_h1_color, widget_button_color, widget_visitor_message_color, widget_quick_replies) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, userId, widget_header_color, widget_h1_color, widget_button_color, widget_visitor_message_color, widget_quick_replies]
        );
        const businessId = result.insertId;
        // Add user as admin in business_users
        await connection.execute(
            'INSERT INTO business_users (business_id, user_id, role) VALUES (?, ?, ?)',
            [businessId, userId, 'admin']
        );
        await connection.end();
        // Redirect to the new dashboard URL
        return res.redirect(`/dashboard/${businessId}`);
    } catch (err) {
        return res.redirect('/dashboard');
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Widget embed route (with chat history)
app.get('/widget/:businessId', async (req, res) => {
    const businessId = req.params.businessId;
    let business = null;
    let messages = [];
    // Widget settings preview support
    const preview = req.query.preview === '1';
    let visitorId;
    let widgetHeaderName, widgetHeaderColor, widgetQuickReplies;
    let widgetH1Color, widgetButtonColor, widgetVisitorMessageColor;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) {
            await connection.end();
            return res.status(404).send('Business not found');
        }
        business = bizRows[0];
        if (preview) {
            // Always use a new visitorId and no messages for preview
            visitorId = uuidv4();
            messages = [];
        } else {
            visitorId = req.cookies.visitorId;
            if (!visitorId) {
                visitorId = uuidv4();
                res.cookie('visitorId', visitorId, { maxAge: 1000 * 60 * 60 * 24 * 30 }); // 30 days
            }
            // Find conversation for this visitor
            const [convRows] = await connection.execute(
                'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ?',
                [businessId, visitorId]
            );
            let conversationId = null;
            if (convRows.length > 0) {
                conversationId = convRows[0].id;
                // Load messages
                const [msgRows] = await connection.execute(
                    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
                    [conversationId]
                );
                messages = msgRows;
            }
        }
        await connection.end();
        // Widget settings: use preview query params if present, else DB, else fallback
        widgetHeaderName = req.query.headerName || business.widget_header_name || business.name + ' Live Chat';
        widgetHeaderColor = req.query.headerColor || business.widget_header_color || '#eee';
        let quickRepliesRaw = req.query.quickReplies || business.widget_quick_replies || '';
        widgetQuickReplies = quickRepliesRaw.split('\n').map(q => q.trim()).filter(q => q.length > 0);
        widgetH1Color = req.query.h1Color || business.widget_h1_color || '#000000';
        widgetButtonColor = req.query.buttonColor || business.widget_button_color || '#B31111';
        widgetVisitorMessageColor = req.query.visitorMessageColor || business.widget_visitor_message_color || '#007bff';
    } catch (err) {
        return res.status(500).send('Server error');
    }
    res.render('widget', {
        business,
        messages,
        visitorId,
        widgetHeaderName,
        widgetHeaderColor,
        widgetQuickReplies,
        widgetH1Color,
        widgetButtonColor,
        widgetVisitorMessageColor
    });
});

// Conversation view route
app.get('/business/:businessId/chats/:conversationId', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.businessId;
    const conversationId = req.params.conversationId;
    let business = null;
    let isOwner = false;
    let isMember = false;
    let conversation = null;
    let messages = [];
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Get business
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) {
            await connection.end();
            return res.status(404).send('Business not found');
        }
        business = bizRows[0];
        isOwner = business.owner_user_id === userId;
        // Check if user is a team member
        const [memberRows] = await connection.execute(
            'SELECT * FROM business_users WHERE business_id = ? AND user_id = ?',
            [businessId, userId]
        );
        isMember = memberRows.length > 0;
        if (!isOwner && !isMember) {
            await connection.end();
            return res.status(403).send('You do not have access to this business.');
        }
        // Get conversation
        const [convRows] = await connection.execute(
            'SELECT * FROM conversations WHERE id = ? AND business_id = ?',
            [conversationId, businessId]
        );
        if (convRows.length === 0) {
            await connection.end();
            return res.status(404).send('Conversation not found');
        }
        conversation = convRows[0];
        // Get messages
        const [msgRows] = await connection.execute(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
            [conversationId]
        );
        messages = msgRows;
        await connection.end();
    } catch (err) {
        return res.status(500).send('Server error');
    }
    res.render('conversation', { business, conversation, messages });
});

// API: Get conversations (paginated, searchable)
app.get('/api/business/:id/conversations', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Query conversations
        let query = `SELECT c.*, 
            (SELECT content FROM messages WHERE conversation_id = c.id AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1) as last_user_message,
            (SELECT content FROM messages WHERE conversation_id = c.id AND sender_type IN ('agent','bot') ORDER BY created_at DESC LIMIT 1) as last_bot_message,
            (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
            (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = 0 AND sender_type = 'user') as unread_count
            FROM conversations c WHERE c.business_id = ?`;
        let params = [businessId];
        if (search) {
            query += ' AND (' +
                'c.visitor_name LIKE ? OR c.id LIKE ? OR EXISTS (' +
                'SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)' +
            ')';
            params.push(search, search, search);
        }
        query += ' ORDER BY CASE WHEN c.status = "handled" THEN 0 WHEN c.status = "active" THEN 1 ELSE 2 END, last_message_time DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        const [rows] = await connection.execute(query, params);
        // Total count
        const [countRows] = await connection.execute('SELECT COUNT(*) as count FROM conversations WHERE business_id = ?', [businessId]);
        const total = countRows[0].count;
        await connection.end();
        res.json({ conversations: rows, hasMore: offset + limit < total });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Get conversation metadata
app.get('/api/business/:id/conversations/:conversationId', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Get conversation
        const [convRows] = await connection.execute('SELECT * FROM conversations WHERE id = ? AND business_id = ?', [conversationId, businessId]);
        if (convRows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
        await connection.end();
        res.json({ conversation: convRows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Get messages for a conversation
app.get('/api/business/:id/conversations/:conversationId/messages', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Get messages
        const [msgRows] = await connection.execute('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
        await connection.end();
        res.json({ messages: msgRows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Take over conversation
app.post('/api/business/:id/conversations/:conversationId/takeover', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Update conversation status
        await connection.execute('UPDATE conversations SET status = ? WHERE id = ? AND business_id = ?', ['handled', conversationId, businessId]);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Let bot handle conversation
app.post('/api/business/:id/conversations/:conversationId/let-bot-handle', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Update conversation status
        await connection.execute('UPDATE conversations SET status = ? WHERE id = ? AND business_id = ?', ['active', conversationId, businessId]);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Delete conversation
app.delete('/api/business/:id/conversations/:conversationId', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Delete messages and conversation
        await connection.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
        await connection.execute('DELETE FROM conversations WHERE id = ? AND business_id = ?', [conversationId, businessId]);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Get team members
app.get('/api/business/:id/team', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Get team members
        const [teamRows] = await connection.execute(
            `SELECT u.id, u.name, u.email, bu.role 
             FROM users u 
             JOIN business_users bu ON u.id = bu.user_id 
             WHERE bu.business_id = ?`,
            [businessId]
        );
        await connection.end();
        res.json({ team: teamRows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Add team member
app.post('/api/business/:id/team', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Missing fields' });
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Find user by email
        const [userRows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
        const newUser = userRows[0];
        // Add to business_users
        await connection.execute('INSERT IGNORE INTO business_users (business_id, user_id, role) VALUES (?, ?, ?)', [businessId, newUser.id, role]);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Remove team member
app.delete('/api/business/:id/team/:userId', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const removeUserId = req.params.userId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Remove from business_users
        await connection.execute('DELETE FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, removeUserId]);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Get widget settings
app.get('/api/business/:id/widget-settings', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        await connection.end();
        res.json({ settings: business });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Update widget settings
app.post('/api/business/:id/widget-settings', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const { widget_header_name, widget_header_color, widget_quick_replies, widget_h1_color, widget_button_color, widget_visitor_message_color } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        await connection.execute(
            'UPDATE businesses SET widget_header_name = ?, widget_header_color = ?, widget_quick_replies = ?, widget_h1_color = ?, widget_button_color = ?, widget_visitor_message_color = ? WHERE id = ?',
            [widget_header_name, widget_header_color, widget_quick_replies, widget_h1_color, widget_button_color, widget_visitor_message_color, businessId]
        );
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Mark visitor messages as read in a conversation
app.post('/api/business/:id/conversations/:conversationId/mark-read', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const conversationId = req.params.conversationId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Check access
        const [bizRows] = await connection.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) return res.status(404).json({ error: 'Business not found' });
        const business = bizRows[0];
        const [memberRows] = await connection.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
        if (business.owner_user_id !== userId && memberRows.length === 0) return res.status(403).json({ error: 'Forbidden' });
        // Mark all visitor messages as read
        await connection.execute('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_type = ? AND is_read = 0', [conversationId, 'user']);
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
}); 