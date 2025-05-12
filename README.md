[![GitHub](https://img.shields.io/badge/GitHub-Livechat--SAAS-blue?logo=github)](https://github.com/jamoyex/Livechat-SAAS)

# Livechat-SAAS

A real-time chat application built with Node.js, Express, PostgreSQL, and Socket.IO. This application features a multi-tenant structure where users can manage multiple businesses, each with their own team and chat widget.

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
- **AI Training Data Management:** Add, edit, and delete Q&A, Links, and Text entries for AI training, each with their own tab and modal in the dashboard
- **Bot Training Workflow:** Train Bot button triggers a webhook and displays last trained time (or 'Not trained yet')
- **Robust UX:** Improved modals, validation (including URL validation for links), and error handling throughout the dashboard
- **Bot Last Trained Display:** Dashboard shows bot's last trained time in user's local timezone, with fallback if not trained
- **Improved Event Handling:** All dashboard features (modals, tabs, business switching, etc.) are robust and error-free

## AI Training & Bot Management

- **Multi-Tabbed AI Training Data:** Manage Q&A, Links, and Text training data for your AI bot, each in their own tab with add/edit/delete modals.
- **Train Bot Button:** Instantly trigger bot retraining via a configurable webhook. Confirmation modal and error handling included.
- **Last Trained Time:** See when your bot was last trained, displayed in your local timezone, or 'Not trained yet' if never trained.
- **Validation & UX:** URL validation for links, required fields for Q&A/Text, and clear error/success feedback for all actions.
- **Backend & Schema:**
  - `ai_training_data` table supports `type` (qa, link, text) and relevant columns.
  - `businesses` table includes `bot_last_trained` timestamp.
- **Security & Robustness:** All dashboard event handling is wrapped in null checks and runs after DOMContentLoaded for reliability.

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v13+)
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

3. Create a `.env` file in the root directory with your PostgreSQL and app credentials:
```
DB_HOST=your-db-host
DB_USER=your-db-user
DB_PASS=your-db-password
DB_NAME=your-db-name
SESSION_SECRET=your-session-secret
PORT=3001
TRAIN_BOT_WEBHOOK_URL=yourn8nurlforimplementingqdrant
```

4. Run the schema to create the tables:
```bash
psql -U <user> -d <database> -f schema_pg.sql
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
- widget_settings (JSONB, optional)
- widget_quick_replies (TEXT)
- widget_header_color (VARCHAR)
- widget_header_name (VARCHAR)
- widget_h1_color (VARCHAR)
- widget_button_color (VARCHAR)
- widget_visitor_message_color (VARCHAR)
- chatbase_api_key (VARCHAR)
- chatbase_agent_id (VARCHAR)
- n8n_webhook_url (VARCHAR)
- n8n_system_prompt (TEXT)
- created_at
- **bot_last_trained (TIMESTAMP)**

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
- status (`active`, `handled`, `closed`)
- last_message_at
- created_at

### messages
- id (PK)
- conversation_id (FK)
- content (TEXT)
- sender_type (`user`, `agent`, `bot`)
- ai_response_id (VARCHAR, optional)
- is_read (BOOLEAN)
- created_at

### ai_training_data
- id (PK)
- business_id (FK)
- **type (qa, link, text)**
- question (TEXT, nullable)
- answer (TEXT, nullable)
- link (TEXT, nullable)
- text (TEXT, nullable)
- created_at
- updated_at

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