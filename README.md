[![GitHub](https://img.shields.io/badge/GitHub-Livechat--SAAS-blue?logo=github)](https://github.com/jamoyex/Livechat-SAAS)

# Livechat-SAAS

A real-time chat application built with Node.js, Express, MySQL, and Socket.IO. This application features a multi-tenant structure where users can manage multiple businesses, each with their own team and chat widget.

## Features

- Multi-tenant: Users can own or be part of multiple businesses
- Real-time chat using WebSocket (Socket.IO)
- User authentication (email/password)
- Business/team management
- Dashboard for managing businesses and conversations
- Message read status tracking (real-time seen/unread updates)
- Role-based access (admin, agent)
- Customizable chat widget (colors, quick replies, header)
- Environment variable support via `.env`

## Prerequisites

- Node.js (v14 or higher)
- MySQL (v5.7+ or MariaDB)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone https://github.com/jamoyex/Livechat-SAAS.git
cd Livechat-SAAS
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with your MySQL and app credentials:
```
DB_HOST=your-db-host
DB_USER=your-db-user
DB_PASS=your-db-password
DB_NAME=your-db-name
SESSION_SECRET=your-session-secret
PORT=3001
```

4. Run the schema to create the tables:
```bash
mysql -u <user> -p <database> < schema.sql
```

5. Start the application:
```bash
node app.js
```

## Database Schema

### users
- id (PK)
- email (unique)
- password (hashed)
- name
- created_at

### businesses
- id (PK)
- name
- owner_user_id (FK to users)
- widget_settings (JSON, optional)
- widget_quick_replies (TEXT)
- widget_header_color (VARCHAR)
- widget_header_name (VARCHAR)
- widget_h1_color (VARCHAR)
- widget_button_color (VARCHAR)
- widget_visitor_message_color (VARCHAR)
- created_at

### business_users
- id (PK)
- business_id (FK)
- user_id (FK)
- role (`admin`, `agent`)
- created_at
- unique (business_id, user_id)

### conversations
- id (PK)
- business_id (FK)
- visitor_name
- visitor_email
- assigned_to (FK to business_users, nullable)
- status (`active`, `handled`, `closed`)
- last_message_at
- created_at

### messages
- id (PK)
- conversation_id (FK)
- content (TEXT)
- sender_type (`user`, `agent`, `bot`)
- sender_id (FK to business_users, nullable)
- is_read (TINYINT, 0/1)
- created_at

## Authentication Flow
- Users register with name, email, and password
- Users log in with email and password
- After login, users can create or join businesses
- Each business can have multiple team members (admins, agents)
- Conversations and messages are managed per business

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License. 