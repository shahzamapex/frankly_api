# ⚙️ Frankly Warehouse Management Backend REST API

High-performance **Node.js / Express REST API** backend serving the Frankly Warehouse Management multi-platform application. Powered by **PostgreSQL (Supabase)**, **Cloudinary** for image/invoice CDN delivery, and **JWT Bearer Token** security.

---

## 📑 Table of Contents
1. [Architecture & Technology Stack](#-architecture--technology-stack)
2. [Authentication & Authorization](#-authentication--authorization)
3. [Complete API Endpoints Directory](#-complete-api-endpoints-directory)
   - [1. Authentication (`/api/auth`)](#1-authentication-apiauth)
   - [2. Inventory Management (`/api/inventory`)](#2-inventory-management-apiinventory)
   - [3. Transactions & Movement Ledger (`/api/transaction`)](#3-transactions--movement-ledger-apitransaction)
   - [4. Deliveries & Inward Goods (`/api/delivery`)](#4-deliveries--inward-goods-apidelivery)
   - [5. Sites & Locations (`/api/site`)](#5-sites--locations-apisite)
   - [6. Users & Employees (`/api/users`)](#6-users--employees-apiusers)
   - [7. Vendors & Suppliers (`/api/vendor`)](#7-vendors--suppliers-apivendor)
   - [8. File & Media Uploads (`/api/upload`)](#8-file--media-uploads-apiupload)
   - [9. Dynamic System Config (`/api/app-config`)](#9-dynamic-system-config-apiapp-config)
4. [Environment Variables Reference](#-environment-variables-reference)
5. [Error Handling & HTTP Status Codes](#-error-handling--http-status-codes)

---

## 🚀 Architecture & Technology Stack

* **Runtime**: Node.js `^18.x` / `^20.x` with Express.js.
* **Database Layer**: Supabase PostgreSQL with automated indexed relational queries.
* **Media & Cloud Storage**: Cloudinary CDN (for product images, delivery invoices, and proof receipts).
* **Security & Tokens**: JSON Web Tokens (`jsonwebtoken`), bcrypt password hashing, and role-based permissions (`ADMIN`, `STORE_KEEPER`, `MANAGER`, `VIEWER`).

---

## 🔐 Authentication & Authorization

All protected endpoints require the HTTP Authorization header:
```http
Authorization: Bearer <jwt_access_token>
```

---

## 📡 Complete API Endpoints Directory

---

### 1. Authentication (`/api/auth`)

#### `POST /api/auth/login`
Authenticates a user and returns a JWT access token and user profile.

* **Request Payload**:
```json
{
  "username": "storekeeper1",
  "password": "Password123!"
}
```

* **Success Response (`200 OK`)**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "c7a8b4e1-2f3a-4b9e-9d2a-8f1b3e4a5b6c",
    "username": "storekeeper1",
    "fullName": "Muhammad Rizwan",
    "role": "ADMIN",
    "isActive": true
  }
}
```

---

#### `POST /api/auth/signup`
Creates a new system user or staff member.

* **Request Payload**:
```json
{
  "username": "johndoe",
  "password": "SecurePassword123!",
  "fullName": "John Doe",
  "role": "STORE_KEEPER",
  "mobile": "+971501234567"
}
```

---

#### `GET /api/auth/me`
Fetches current authenticated session user profile.

* **Success Response (`200 OK`)**:
```json
{
  "user": {
    "id": "c7a8b4e1-2f3a-4b9e-9d2a-8f1b3e4a5b6c",
    "username": "storekeeper1",
    "fullName": "Muhammad Rizwan",
    "role": "ADMIN"
  }
}
```

---

#### `POST /api/auth/change-password`
Updates the logged-in user's account password.

* **Request Payload**:
```json
{
  "currentPassword": "OldPassword123!",
  "newPassword": "NewSecurePassword456!"
}
```

---

### 2. Inventory Management (`/api/inventory`)

#### `GET /api/inventory`
Retrieves all inventory items with real-time stock levels, category, and assigned location breakdown.

* **Query Parameters**:
  - `category` (optional): Filter by category (e.g. `TOOLS`, `MATERIAL`, `APPLIANCE`, `BATTERY_CHARGER`).
  - `search` (optional): Query string matching item name or SKU.
  - `lowStock` (optional): `true` to filter items below minimum alert threshold.

* **Success Response (`200 OK`)**:
```json
[
  {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "name": "DeWalt Cordless Drill 18V",
    "sku": "TL-DW-001",
    "category": "TOOLS",
    "unit": "PCS",
    "initialStock": 20,
    "currentStock": 14,
    "minAlert": 5,
    "imageUrl": "https://res.cloudinary.com/.../drill.jpg",
    "locationBreakdown": {
      "DXB-01": 4,
      "Eng. Muhammad Rizwan": 2
    },
    "createdAt": "2026-08-01T10:00:00.000Z"
  }
]
```

---

#### `POST /api/inventory`
Registers a new product/item into the warehouse catalog.

* **Request Payload**:
```json
{
  "name": "Bosch Angle Grinder 4-Inch",
  "sku": "TL-BOS-042",
  "category": "TOOLS",
  "unit": "PCS",
  "initialStock": 10,
  "minAlert": 2,
  "imageUrl": "https://res.cloudinary.com/.../grinder.jpg",
  "description": "Heavy-duty 850W angle grinder"
}
```

---

#### `PUT /api/inventory/:id`
Updates product metadata, unit, category, or min alert threshold.

* **Request Payload**:
```json
{
  "name": "Bosch Angle Grinder 4-Inch (Heavy Duty)",
  "category": "TOOLS",
  "minAlert": 3
}
```

---

#### `DELETE /api/inventory/:id`
Removes an item from the catalog (allowed only if no historical transactions exist).

---

### 3. Transactions & Movement Ledger (`/api/transaction`)

#### `GET /api/transaction`
Retrieves paginated and filtered historical transactions.

* **Query Parameters**:
  - `type` (optional): `ISSUE_SITE`, `ISSUE_EMPLOYEE`, `RETURN_SITE`, `RETURN_EMPLOYEE`, `SITE_TRANSFER`, `ISSUE_REPAIR`, `RETURN_REPAIR`, `ISSUE_SCRAP`.
  - `startDate` / `endDate` (optional): Date range (`YYYY-MM-DD`).
  - `siteId` (optional): Filter by site.
  - `employeeId` (optional): Filter by employee.

* **Success Response (`200 OK`)**:
```json
[
  {
    "id": "e3b0c442-98fc-1c14-9afb-4c8996fb9242",
    "transactionId": "TX-20260826-0012",
    "type": "ISSUE_SITE",
    "itemId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "itemName": "DeWalt Cordless Drill 18V",
    "quantity": 2,
    "fromSite": "WAREHOUSE",
    "toSite": "DXB-01",
    "employeeName": "Ali Hassan",
    "proofImageUrl": "https://res.cloudinary.com/.../receipt.jpg",
    "notes": "Issued for electrical installation team",
    "timestamp": "2026-08-26T14:30:00.000Z"
  }
]
```

---

#### `POST /api/transaction`
Logs a new stock movement and immediately recalculates warehouse and location balances.

* **Request Payload**:
```json
{
  "type": "ISSUE_SITE",
  "itemId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "quantity": 2,
  "toSiteId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "employeeId": "c7a8b4e1-2f3a-4b9e-9d2a-8f1b3e4a5b6c",
  "proofImageUrl": "https://res.cloudinary.com/.../proof.jpg",
  "notes": "Site issue for Dubai Mall Project"
}
```

---

#### `POST /api/transaction/bulk`
Executes multiple movement entries in a single atomic transaction.

* **Request Payload**:
```json
{
  "transactions": [
    {
      "type": "ISSUE_SITE",
      "itemId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "quantity": 2,
      "toSiteId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
    },
    {
      "type": "ISSUE_SITE",
      "itemId": "2c5e0324-4f21-4d32-8419-4a0b2d6a7e91",
      "quantity": 50,
      "toSiteId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
    }
  ]
}
```

---

### 4. Deliveries & Inward Goods (`/api/delivery`)

#### `GET /api/delivery`
Retrieves all supplier deliveries and inward goods notes.

---

#### `POST /api/delivery`
Logs a new inward delivery from a supplier and increments available warehouse stocks.

* **Request Payload**:
```json
{
  "deliveryId": "DEL-2026-089",
  "deliveryDate": "2026-08-26T10:00:00.000Z",
  "seller": "Al Futtaim Engineering",
  "receivedBy": "Muhammad Rizwan",
  "invoiceImageUrl": "https://res.cloudinary.com/.../inv089.jpg",
  "items": [
    {
      "itemId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "quantity": 10,
      "unitPrice": 450.00
    }
  ],
  "remarks": "Received in good condition"
}
```

---

### 5. Sites & Locations (`/api/site`)

#### `GET /api/site`
Retrieves list of all active construction project sites and main warehouses.

* **Success Response (`200 OK`)**:
```json
[
  {
    "id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "siteCode": "DXB-01",
    "siteName": "Dubai Hills Villa Project",
    "location": "Dubai Hills Estate, UAE",
    "status": "active",
    "isWarehouse": false
  }
]
```

---

#### `POST /api/site`
Registers a new project site.

* **Request Payload**:
```json
{
  "siteCode": "AUH-04",
  "siteName": "Yas Island Commercial Tower",
  "location": "Yas Island, Abu Dhabi",
  "status": "active"
}
```

---

### 6. Users & Employees (`/api/users`)

#### `GET /api/users`
Retrieves all employees, engineers, and store keepers.

---

#### `GET /api/users/:id/items`
Retrieves all tools and materials currently checked out / in custody of a specific employee.

---

### 7. Vendors & Suppliers (`/api/vendor`)

#### `GET /api/vendor`
Retrieves vendor directory with contact persons, phone numbers, and payment terms.

---

#### `POST /api/vendor`
Registers a new supplier/vendor.

* **Request Payload**:
```json
{
  "name": "Hilti Emirates LLC",
  "contactPerson": "Mark Davis",
  "email": "orders@hilti.ae",
  "phone": "+971480044584",
  "address": "Al Quoz Industrial Area 3, Dubai"
}
```

---

### 8. File & Media Uploads (`/api/upload`)

#### `POST /api/upload`
Uploads image or PDF proof to Cloudinary and returns CDN URL.

* **Header**: `Content-Type: multipart/form-data`
* **Form Field**: `file` (File binary: PNG, JPG, JPEG, WEBP, PDF)
* **Response (`201 Created`)**:
```json
{
  "url": "https://res.cloudinary.com/frankly/image/upload/v1724700000/transactions/tx_proof_8912.jpg",
  "publicId": "transactions/tx_proof_8912",
  "format": "jpg",
  "bytes": 245812
}
```

---

### 9. Dynamic System Config (`/api/app-config`)

#### `GET /api/app-config`
Fetches global app configurations, maintenance flags, and version checks.

---

## 🔑 Environment Variables Reference

Create a `.env` file in the `api/` root directory:

```env
PORT=5000
NODE_ENV=production

# Supabase PostgreSQL Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# JWT Authentication
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRES_IN=7d

# Cloudinary Storage
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

---

## 🚦 Error Handling & HTTP Status Codes

| Code | Status | Meaning |
| :--- | :--- | :--- |
| `200` | **OK** | Request completed successfully. |
| `201` | **Created** | New record created successfully. |
| `400` | **Bad Request** | Invalid payload or missing required fields. |
| `401` | **Unauthorized** | Missing or expired JWT authentication token. |
| `403` | **Forbidden** | Insufficient user role/permissions for operation. |
| `404` | **Not Found** | Requested resource ID does not exist. |
| `409` | **Conflict** | Duplicate SKU, Site Code, or Username. |
| `500` | **Server Error** | Internal database or server exception. |
