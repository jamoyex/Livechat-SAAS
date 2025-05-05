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
const zlib = require('zlib');
const rateLimit = require('express-rate-limit');
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
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server);

// Cache for business settings
const businessCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Message batch size for loading
const MESSAGE_BATCH_SIZE = 50;

// Rate limiters
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: { error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const widgetLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    message: { error: 'Too many widget requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Helper function to compress messages
function compressMessages(messages) {
    return new Promise((resolve, reject) => {
        zlib.deflate(JSON.stringify(messages), (err, buffer) => {
            if (err) reject(err);
            else resolve(buffer.toString('base64'));
        });
    });
}

// Helper function to decompress messages
function decompressMessages(compressed) {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.from(compressed, 'base64');
        zlib.inflate(buffer, (err, decompressed) => {
            if (err) reject(err);
            else resolve(JSON.parse(decompressed.toString()));
        });
    });
}

// Helper function to get business settings with caching
async function getBusinessSettings(businessId) {
    if (businessCache.has(businessId)) {
        const cached = businessCache.get(businessId);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }
    }

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM businesses WHERE id = ?',
            [businessId]
        );
        if (rows.length > 0) {
            const settings = rows[0];
            businessCache.set(businessId, {
                data: settings,
                timestamp: Date.now()
            });
            return settings;
        }
    } catch (err) {
        console.error('Error fetching business settings:', err);
    }
    return null;
}

// Clear cache periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of businessCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            businessCache.delete(key);
        }
    }
}, CACHE_TTL);

// Optimized message loading with compression
async function getPaginatedMessages(conversationId, page = 1, limit = MESSAGE_BATCH_SIZE) {
    const offset = (page - 1) * limit;
    try {
        const [messages] = await pool.execute(
            `SELECT id, conversation_id, content, sender_type, is_read, created_at 
             FROM messages 
             WHERE conversation_id = ? 
             ORDER BY created_at DESC 
             LIMIT ? OFFSET ?`,
            [conversationId, limit, offset]
        );
        
        // Compress messages before sending
        const compressed = await compressMessages(messages);
        return { messages: compressed, hasMore: messages.length === limit };
    } catch (err) {
        console.error('Error loading messages:', err);
        throw err;
    }
}

// Socket.IO connection for widget and admin/agent
io.on('connection', (socket) => {
    // Visitor joins a conversation
    socket.on('visitor join', async ({ businessId, visitorId }) => {
        let conversationId;
        try {
            const [convRows] = await pool.execute(
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
        } catch (err) {
            console.error('Error in visitor join:', err);
        }
    });

    // Handle closing conversation
    socket.on('close conversation', async ({ businessId, visitorId }) => {
        try {
            // Find and close the current conversation
            const [convRows] = await pool.execute(
                'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ? AND status = "active"',
                [businessId, visitorId]
            );
            
            if (convRows.length > 0) {
                const conversationId = convRows[0].id;
                // Update conversation status to closed
                await pool.execute(
                    'UPDATE conversations SET status = "closed" WHERE id = ?',
                    [conversationId]
                );
                
                // Leave the conversation room
                socket.leave('conv_' + conversationId);
                
                // Notify business room about closed conversation
                io.to('business_' + businessId).emit('conversation closed', { 
                    businessId, 
                    conversationId 
                });
            }
        } catch (err) {
            console.error('Error closing conversation:', err);
        }
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
    // Load messages with pagination and compression
    socket.on('load messages', async ({ conversationId, page = 1 }) => {
        try {
            const { messages: compressed, hasMore } = await getPaginatedMessages(conversationId, page);
            socket.emit('messages loaded', { messages: compressed, page, hasMore });
        } catch (err) {
            console.error('Error loading messages:', err);
            socket.emit('error', { message: 'Failed to load messages' });
        }
    });
    // Handle compressed messages
    socket.on('chat message', async (data) => {
        try {
            const decompressed = await decompressMessages(data.messages);
            // Process decompressed messages
            // ... rest of the message handling code ...
        } catch (err) {
            console.error('Error processing compressed messages:', err);
        }
    });
    // Visitor sends a message
    socket.on('visitor message', async (data) => {
        const { content } = data;
        let conversationId = socket.data.conversationId;
        let businessId = socket.data.businessId || data.businessId;
        let visitorId = socket.data.visitorId || data.visitorId;
        let isNewConversation = false;
        let business = null;
        let conversationStatus = null;
        try {
            // If no conversation, create it now
            if (!conversationId) {
                const [convRows] = await pool.execute(
                    'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ?',
                    [businessId, visitorId]
                );
                if (convRows.length > 0) {
                    conversationId = convRows[0].id;
                } else {
                    const [result] = await pool.execute(
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
            // Fetch conversation status
            const [convStatusRows] = await pool.execute('SELECT status FROM conversations WHERE id = ?', [conversationId]);
            if (convStatusRows.length > 0) conversationStatus = convStatusRows[0].status;
            await pool.execute(
                'INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())',
                [conversationId, content, 'user', 0]
            );
            await pool.execute(
                'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
                [conversationId]
            );
            // Fetch business settings for AI
            const [bizRows] = await pool.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
            if (bizRows.length > 0) business = bizRows[0];
        } catch (err) {
            console.error('Error in visitor message:', err);
        }
        // Broadcast to all in the conversation (including admins/agents)
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'user', conversationId, content, status: conversationStatus });
        // Emit to business room for new or updated conversation
        if (isNewConversation) {
            io.to('business_' + businessId).emit('new conversation', { businessId, conversationId });
        } else {
            io.to('business_' + businessId).emit('update conversation', { businessId, conversationId });
        }
        // AI Agent via N8N webhook (only if status is active)
        if (business && business.n8n_webhook_url && conversationStatus === 'active') {
            try {
                const n8nPayload = {
                    message: content,
                    system_prompt: business.n8n_system_prompt || '',
                    session_id: visitorId
                };
                const n8nRes = await fetch(business.n8n_webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(n8nPayload)
                });
                if (n8nRes.ok) {
                    let aiReply = await n8nRes.text();
                    try {
                        const parsed = JSON.parse(aiReply);
                        if (parsed && typeof parsed === 'object' && parsed.output) {
                            aiReply = parsed.output;
                        }
                    } catch (e) {
                        // Not JSON, use as is
                    }
                    if (aiReply && aiReply.trim().length > 0) {
                        await pool.execute(
                            'INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())',
                            [conversationId, aiReply, 'bot', 0]
                        );
                        await pool.execute(
                            'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
                            [conversationId]
                        );
                        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'bot', conversationId, content: aiReply, status: conversationStatus });
                    }
                }
            } catch (err) {
                console.error('Error calling N8N webhook:', err);
            }
        }
    });
    // Admin/agent sends a message
    socket.on('admin message', async (data) => {
        const { businessId, conversationId, content } = data;
        if (!conversationId) return;
        try {
            // Only allow admin/agent to reply if status is handled
            const [convStatusRows] = await pool.execute('SELECT status FROM conversations WHERE id = ?', [conversationId]);
            if (convStatusRows.length === 0 || convStatusRows[0].status !== 'handled') {
                return; // Do not allow reply if not handled
            }
            await pool.execute(
                'INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())',
                [conversationId, content, 'agent', 0]
            );
            await pool.execute(
                'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
                [conversationId]
            );
        } catch (err) {
            console.error('Error in admin message:', err);
        }
        // Broadcast to all in the conversation (including visitor)
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'agent', conversationId, content, status: 'handled' });
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
app.post('/register', authLimiter, async (req, res) => {
    const { email, password, name } = req.body;
    let error;
    if (!email || !password || !name) {
        error = 'All fields are required.';
        return res.render('register', { error });
    }
    try {
        // Check if email already exists
        const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (rows.length > 0) {
            error = 'Email already exists.';
            return res.render('register', { error });
        }
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        // Insert new user
        const [result] = await pool.execute(
            'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
            [email, hashedPassword, name]
        );
        // Get the new user ID
        const userId = result.insertId;
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
app.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    let error;
    if (!email || !password) {
        error = 'All fields are required.';
        return res.render('login', { error });
    }
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
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
        const [owned] = await pool.execute(
            'SELECT * FROM businesses WHERE owner_user_id = ?', [userId]
        );
        const [member] = await pool.execute(
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
        const [owned] = await pool.execute(
            'SELECT * FROM businesses WHERE owner_user_id = ?', [userId]
        );
        const [member] = await pool.execute(
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
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
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
            await connection.commit();
            // Redirect to the new dashboard URL
            return res.redirect(`/dashboard/${businessId}`);
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
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
app.get('/widget/:businessId', widgetLimiter, async (req, res) => {
    const businessId = req.params.businessId;
    let business = await getBusinessSettings(businessId);
    if (!business) {
        return res.status(404).send('Business not found');
    }
    let messages = [];
    // Widget settings preview support
    const preview = req.query.preview === '1';
    let visitorId;
    let widgetHeaderName, widgetHeaderColor, widgetQuickReplies;
    let widgetH1Color, widgetButtonColor, widgetVisitorMessageColor;
    try {
        const [bizRows] = await pool.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
        if (bizRows.length === 0) {
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
            const [convRows] = await pool.execute(
                'SELECT * FROM conversations WHERE business_id = ? AND visitor_name = ?',
                [businessId, visitorId]
            );
            let conversationId = null;
            if (convRows.length > 0) {
                conversationId = convRows[0].id;
                // Load messages
                const [msgRows] = await pool.execute(
                    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
                    [conversationId]
                );
                messages = msgRows;
            }
        }
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
        const connection = await pool.getConnection();
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

// Helper function to check if a user has access to a business
async function checkBusinessAccess(businessId, userId) {
    const [bizRows] = await pool.execute('SELECT * FROM businesses WHERE id = ?', [businessId]);
    if (bizRows.length === 0) return { error: 'Business not found' };
    const business = bizRows[0];
    const [memberRows] = await pool.execute('SELECT * FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, userId]);
    if (business.owner_user_id !== userId && memberRows.length === 0) return { error: 'Forbidden' };
    return { business };
}

// API: Get conversations (paginated, searchable)
app.get('/api/business/:id/conversations', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;
    try {
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Query conversations
        let query = `SELECT c.*, 
            (SELECT content FROM messages WHERE conversation_id = c.id AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1) as last_user_message,
            (SELECT content FROM messages WHERE conversation_id = c.id AND sender_type IN ('agent','bot') ORDER BY created_at DESC LIMIT 1) as last_bot_message,
            (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
            (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = 0 AND sender_type = 'user') as unread_count
            FROM conversations c WHERE c.business_id = ?`;
        let params = [businessId];
        if (search) {
            query += ' AND (c.visitor_name LIKE ? OR c.visitor_email LIKE ?)';
            params.push(search, search);
        }
        query += ' ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        const [conversations] = await pool.execute(query, params);
        res.json({ conversations });
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Get conversation
        const [convRows] = await pool.execute('SELECT * FROM conversations WHERE id = ? AND business_id = ?', [conversationId, businessId]);
        if (convRows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Get messages
        const [msgRows] = await pool.execute('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Update conversation status
        await pool.execute('UPDATE conversations SET status = ? WHERE id = ? AND business_id = ?', ['handled', conversationId, businessId]);
        // Insert bot message
        await pool.execute('INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())', [conversationId, 'A human agent took over this conversation', 'bot', 0]);
        await pool.execute('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
        // Emit bot message to conversation
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'bot', conversationId, content: 'A human agent took over this conversation', status: 'handled' });
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Update conversation status
        await pool.execute('UPDATE conversations SET status = ? WHERE id = ? AND business_id = ?', ['active', conversationId, businessId]);
        // Insert bot message
        await pool.execute('INSERT INTO messages (conversation_id, content, sender_type, is_read, created_at) VALUES (?, ?, ?, ?, NOW())', [conversationId, 'The AI assistant is now handling this conversation.', 'bot', 0]);
        await pool.execute('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
        // Emit bot message to conversation
        io.to('conv_' + conversationId).emit('chat message', { sender_type: 'bot', conversationId, content: 'The AI assistant is now handling this conversation.', status: 'active' });
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
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const { error, business } = await checkBusinessAccess(businessId, userId);
            if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
            // Delete messages and conversation
            await connection.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
            await connection.execute('DELETE FROM conversations WHERE id = ? AND business_id = ?', [conversationId, businessId]);
            await connection.commit();
            res.json({ success: true });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Get team members
app.get('/api/business/:id/team', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const businessId = req.params.id;
    try {
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Get team members
        const [teamRows] = await pool.execute(
            `SELECT u.id, u.name, u.email, bu.role 
             FROM users u 
             JOIN business_users bu ON u.id = bu.user_id 
             WHERE bu.business_id = ?`,
            [businessId]
        );
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
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const { error, business } = await checkBusinessAccess(businessId, userId);
            if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
            // Find user by email
            const [userRows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
            if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
            const newUser = userRows[0];
            // Add to business_users
            await connection.execute('INSERT IGNORE INTO business_users (business_id, user_id, role) VALUES (?, ?, ?)', [businessId, newUser.id, role]);
            await connection.commit();
            res.json({ success: true });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Remove from business_users
        await pool.execute('DELETE FROM business_users WHERE business_id = ? AND user_id = ?', [businessId, removeUserId]);
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        await pool.execute(
            'UPDATE businesses SET widget_header_name = ?, widget_header_color = ?, widget_quick_replies = ?, widget_h1_color = ?, widget_button_color = ?, widget_visitor_message_color = ? WHERE id = ?',
            [widget_header_name, widget_header_color, widget_quick_replies, widget_h1_color, widget_button_color, widget_visitor_message_color, businessId]
        );
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
        const { error, business } = await checkBusinessAccess(businessId, userId);
        if (error) return res.status(error === 'Business not found' ? 404 : 403).json({ error });
        // Mark all visitor messages as read
        await pool.execute('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_type = ? AND is_read = 0', [conversationId, 'user']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Add decompression endpoint
app.post('/api/decompress', express.json(), async (req, res) => {
    try {
        const { messages } = req.body;
        const decompressed = await decompressMessages(messages);
        res.json(decompressed);
    } catch (err) {
        console.error('Error decompressing messages:', err);
        res.status(500).json({ error: 'Failed to decompress messages' });
    }
});

// Apply rate limiters to routes
app.post('/login', authLimiter, async (req, res) => {
    // ... existing login code ...
});

app.post('/register', authLimiter, async (req, res) => {
    // ... existing register code ...
});

// Apply API limiter to all API routes
app.use('/api', apiLimiter);

// Apply widget limiter to widget routes
app.use('/widget', widgetLimiter);

// Ensure JSON body parsing for API endpoints
app.use(express.json());

// API endpoint to get AI settings
app.get('/api/business/:businessId/ai-settings', requireLogin, async (req, res) => {
    const businessId = parseInt(req.params.businessId);
    const userId = req.session.userId;

    try {
        // Check if user has access to this business
        const [business] = await pool.execute(
            'SELECT * FROM businesses WHERE id = ? AND (owner_user_id = ? OR id IN (SELECT business_id FROM business_users WHERE user_id = ?))',
            [businessId, userId, userId]
        );

        if (business.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json({
            success: true,
            settings: {
                chatbase_api_key: business[0].chatbase_api_key,
                chatbase_agent_id: business[0].chatbase_agent_id,
                n8n_webhook_url: business[0].n8n_webhook_url,
                n8n_system_prompt: business[0].n8n_system_prompt
            }
        });
    } catch (error) {
        console.error('Error fetching AI settings:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API endpoint to update AI settings
app.post('/api/business/:businessId/ai-settings', requireLogin, async (req, res) => {
    const businessId = parseInt(req.params.businessId);
    const userId = req.session.userId;
    const { chatbase_api_key, chatbase_agent_id, n8n_webhook_url, n8n_system_prompt } = req.body;

    try {
        // Check if user has access to this business
        const [business] = await pool.execute(
            'SELECT * FROM businesses WHERE id = ? AND (owner_user_id = ? OR id IN (SELECT business_id FROM business_users WHERE user_id = ? AND role = "admin"))',
            [businessId, userId, userId]
        );

        if (business.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Update AI settings
        await pool.execute(
            'UPDATE businesses SET chatbase_api_key = ?, chatbase_agent_id = ?, n8n_webhook_url = ?, n8n_system_prompt = ? WHERE id = ?',
            [chatbase_api_key, chatbase_agent_id, n8n_webhook_url, n8n_system_prompt, businessId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating AI settings:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
}); 