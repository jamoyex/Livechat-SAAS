-- Users table (for authentication)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Businesses table
CREATE TABLE IF NOT EXISTS businesses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_user_id INT NOT NULL,
    widget_settings JSON,
    widget_quick_replies TEXT,
    widget_header_color VARCHAR(32),
    widget_header_name VARCHAR(128),
    widget_h1_color VARCHAR(32),
    widget_button_color VARCHAR(32),
    widget_visitor_message_color VARCHAR(32),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

-- Business users (team members per business)
CREATE TABLE IF NOT EXISTS business_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    business_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('admin', 'agent') DEFAULT 'agent',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (business_id) REFERENCES businesses(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE KEY unique_user_per_business (business_id, user_id)
);

-- Conversations table (per business)
CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    business_id INT NOT NULL,
    visitor_name VARCHAR(255),
    visitor_email VARCHAR(255),
    assigned_to INT,
    status ENUM('active', 'handled', 'closed') DEFAULT 'active',
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (business_id) REFERENCES businesses(id),
    FOREIGN KEY (assigned_to) REFERENCES business_users(id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    content TEXT NOT NULL,
    sender_type ENUM('user', 'agent', 'bot') NOT NULL,
    sender_id INT,
    is_read TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES business_users(id)
); 
); 