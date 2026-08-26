const swaggerJsdoc = require('swagger-jsdoc');

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Frankly Warehouse Management REST API',
    version: '1.0.0',
    description:
      'Comprehensive REST API for Frankly Built Contracting LLC warehouse, inventory, multi-site distribution, deliveries, and employee equipment custody management system.',
    contact: {
      name: 'Frankly Built Contracting LLC',
      url: 'https://frankly.ae',
      email: 'support@frankly.ae',
    },
  },
  servers: [
    {
      url: 'http://localhost:4000/api',
      description: 'Local Development Server',
    },
    {
      url: 'https://frankly-api.vercel.app/api',
      description: 'Production Cloud Server (Vercel)',
    },
  ],
  tags: [
    { name: 'Authentication', description: 'User login, registration, session profiles, and token refresh' },
    { name: 'Inventory', description: 'Product catalog, stock levels, categories, and location breakdown' },
    { name: 'Transactions', description: 'Material issues, returns, site transfers, repairs, and stock recalculation' },
    { name: 'Deliveries', description: 'Inward supplier deliveries, delivery notes, and purchase invoices' },
    { name: 'Sites', description: 'Construction project sites, warehouses, and current site inventory holdings' },
    { name: 'Users', description: 'Staff members, roles, permissions, and assigned tool custody' },
    { name: 'Vendors', description: 'Suppliers, vendors, credit terms, and contact records' },
    { name: 'Uploads', description: 'Cloudinary CDN media and document attachment uploads' },
    { name: 'App Config', description: 'Dynamic system variables, company profile, and app metadata' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Provide JWT bearer token received from `/auth/login`',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Resource not found' },
          message: { type: 'string', example: 'Operation failed' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', example: 'c7a8b4e1-2f3a-4b9e-9d2a-8f1b3e4a5b6c' },
          username: { type: 'string', example: 'storekeeper1' },
          fullName: { type: 'string', example: 'Muhammad Rizwan' },
          role: { type: 'string', enum: ['ADMIN', 'STORE_KEEPER', 'MANAGER', 'VIEWER'], example: 'ADMIN' },
          email: { type: 'string', example: 'rizwan@frankly.ae' },
          mobile: { type: 'string', example: '+971501234567' },
          isActive: { type: 'boolean', example: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'storekeeper1' },
          password: { type: 'string', example: 'Password123!' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          user: { $ref: '#/components/schemas/User' },
        },
      },
      SignupRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'newuser' },
          password: { type: 'string', example: 'SecurePassword123!' },
          fullName: { type: 'string', example: 'Ali Hassan' },
          role: { type: 'string', example: 'STORE_KEEPER' },
          mobile: { type: 'string', example: '+971509876543' },
        },
      },
      ChangePasswordRequest: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', example: 'OldPassword123!' },
          newPassword: { type: 'string', example: 'NewStrongPassword456!' },
        },
      },
      InventoryItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'DeWalt Cordless Drill 18V' },
          sku: { type: 'string', example: 'TL-DW-001' },
          category: { type: 'string', example: 'TOOLS' },
          unit: { type: 'string', example: 'PCS' },
          initialStock: { type: 'integer', example: 20 },
          currentStock: { type: 'integer', example: 14 },
          minAlert: { type: 'integer', example: 5 },
          imageUrl: { type: 'string', example: 'https://res.cloudinary.com/.../drill.jpg' },
          locationBreakdown: {
            type: 'object',
            additionalProperties: { type: 'integer' },
            example: { 'DXB-01': 4, 'Eng. Muhammad Rizwan': 2 },
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateInventoryItemRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', example: 'Bosch Angle Grinder 4-Inch' },
          sku: { type: 'string', example: 'TL-BOS-042' },
          category: { type: 'string', example: 'TOOLS' },
          unit: { type: 'string', example: 'PCS' },
          initialStock: { type: 'integer', example: 10 },
          minAlert: { type: 'integer', example: 2 },
          imageUrl: { type: 'string', example: 'https://res.cloudinary.com/.../grinder.jpg' },
          description: { type: 'string', example: 'Heavy-duty 850W angle grinder' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          transactionId: { type: 'string', example: 'TX-20260826-0012' },
          type: {
            type: 'string',
            enum: [
              'ISSUE_SITE',
              'ISSUE_EMPLOYEE',
              'RETURN_SITE',
              'RETURN_EMPLOYEE',
              'SITE_TRANSFER',
              'ISSUE_REPAIR',
              'RETURN_REPAIR',
              'ISSUE_SCRAP',
              'DELIVERY',
              'RETURN_NEW',
            ],
            example: 'ISSUE_SITE',
          },
          itemId: { type: 'string', format: 'uuid' },
          itemName: { type: 'string', example: 'DeWalt Cordless Drill 18V' },
          quantity: { type: 'integer', example: 2 },
          fromSite: { type: 'string', example: 'WAREHOUSE' },
          toSite: { type: 'string', example: 'DXB-01' },
          employeeName: { type: 'string', example: 'Ali Hassan' },
          proofImageUrl: { type: 'string', example: 'https://res.cloudinary.com/.../receipt.jpg' },
          notes: { type: 'string', example: 'Issued for electrical team' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      CreateTransactionRequest: {
        type: 'object',
        required: ['type', 'itemId', 'quantity'],
        properties: {
          type: { type: 'string', example: 'ISSUE_SITE' },
          itemId: { type: 'string', format: 'uuid' },
          quantity: { type: 'integer', example: 2 },
          fromSiteId: { type: 'string', format: 'uuid', nullable: true },
          toSiteId: { type: 'string', format: 'uuid', nullable: true },
          employeeId: { type: 'string', format: 'uuid', nullable: true },
          proofImageUrl: { type: 'string', nullable: true },
          notes: { type: 'string', example: 'Site transfer to Dubai Hills' },
        },
      },
      Delivery: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deliveryId: { type: 'string', example: 'DEL-2026-089' },
          deliveryDate: { type: 'string', format: 'date-time' },
          seller: { type: 'string', example: 'Al Futtaim Engineering' },
          receivedBy: { type: 'string', example: 'Muhammad Rizwan' },
          invoiceImageUrl: { type: 'string', example: 'https://res.cloudinary.com/.../inv089.jpg' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                itemId: { type: 'string', format: 'uuid' },
                itemName: { type: 'string' },
                quantity: { type: 'integer', example: 10 },
                unitPrice: { type: 'number', example: 450.0 },
              },
            },
          },
          remarks: { type: 'string', example: 'Received in good condition' },
        },
      },
      Site: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          siteCode: { type: 'string', example: 'DXB-01' },
          siteName: { type: 'string', example: 'Dubai Hills Villa Project' },
          location: { type: 'string', example: 'Dubai Hills Estate, UAE' },
          status: { type: 'string', example: 'active' },
          isWarehouse: { type: 'boolean', example: false },
        },
      },
      Vendor: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Hilti Emirates LLC' },
          contactPerson: { type: 'string', example: 'Mark Davis' },
          email: { type: 'string', example: 'orders@hilti.ae' },
          phone: { type: 'string', example: '+971480044584' },
          address: { type: 'string', example: 'Al Quoz Industrial Area 3, Dubai' },
        },
      },
      AppConfig: {
        type: 'object',
        properties: {
          companyName: { type: 'string', example: 'Frankly Built Contracting LLC' },
          companyAddress: { type: 'string', example: 'Dubai, UAE' },
          appVersion: { type: 'string', example: '1.0.0' },
          appName: { type: 'string', example: 'Frankly' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Authentication'],
        summary: 'User Login & JWT Token Generation',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: {
            description: 'Authentication successful',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          401: { description: 'Invalid username or password' },
        },
      },
    },
    '/auth/signup': {
      post: {
        tags: ['Authentication'],
        summary: 'Register New User Account',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SignupRequest' } } },
        },
        responses: {
          201: { description: 'User created successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          400: { description: 'Validation error' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Authentication'],
        summary: 'Get Current Authenticated User Profile',
        responses: {
          200: { description: 'User profile', content: { 'application/json': { schema: { properties: { user: { $ref: '#/components/schemas/User' } } } } } },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Authentication'],
        summary: 'Update Logged-in User Password',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordRequest' } } },
        },
        responses: {
          200: { description: 'Password changed successfully' },
          400: { description: 'Incorrect current password or invalid format' },
        },
      },
    },
    '/auth/generate-username': {
      post: {
        tags: ['Authentication'],
        summary: 'Generate Unique Username from Full Name',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { firstName: { type: 'string', example: 'Muhammad' }, lastName: { type: 'string', example: 'Rizwan' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Generated username check',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { username: { type: 'string', example: 'mrizwan' }, exists: { type: 'boolean', example: false } } },
              },
            },
          },
        },
      },
    },
    '/inventory': {
      get: {
        tags: ['Inventory'],
        summary: 'Fetch Inventory Catalog with Live Stock & Location Breakdown',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category (TOOLS, MATERIAL, etc.)' },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search query for item name or SKU' },
          { name: 'lowStock', in: 'query', schema: { type: 'boolean' }, description: 'Filter only low stock items' },
        ],
        responses: {
          200: {
            description: 'List of inventory items',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } } } },
          },
        },
      },
      post: {
        tags: ['Inventory'],
        summary: 'Add New Product to Inventory Catalog',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateInventoryItemRequest' } } },
        },
        responses: {
          201: { description: 'Product created', content: { 'application/json': { schema: { $ref: '#/components/schemas/InventoryItem' } } } },
          400: { description: 'Invalid data or duplicate SKU' },
        },
      },
    },
    '/inventory/{id}': {
      get: {
        tags: ['Inventory'],
        summary: 'Get Product Details by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/InventoryItem' } } } },
          404: { description: 'Item not found' },
        },
      },
      put: {
        tags: ['Inventory'],
        summary: 'Update Product Details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, category: { type: 'string' }, minAlert: { type: 'integer' } } } } },
        },
        responses: {
          200: { description: 'Item updated successfully' },
          404: { description: 'Item not found' },
        },
      },
      delete: {
        tags: ['Inventory'],
        summary: 'Delete Product from Catalog',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Item deleted successfully' },
          400: { description: 'Cannot delete item with existing transactions' },
        },
      },
    },
    '/inventory/recalculate-all': {
      post: {
        tags: ['Inventory'],
        summary: 'Recalculate All Inventory Stock Balances from Transaction Ledger',
        responses: {
          200: { description: 'Stock recalculated successfully' },
        },
      },
    },
    '/transactions': {
      get: {
        tags: ['Transactions'],
        summary: 'Fetch Filtered Movement Transactions',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Movement type (ISSUE_SITE, RETURN_SITE, etc.)' },
          { name: 'siteId', in: 'query', schema: { type: 'string' }, description: 'Filter by site' },
          { name: 'employeeId', in: 'query', schema: { type: 'string' }, description: 'Filter by employee' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: {
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } } } },
          },
        },
      },
      post: {
        tags: ['Transactions'],
        summary: 'Create New Material Movement Transaction',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTransactionRequest' } } },
        },
        responses: {
          201: { description: 'Transaction recorded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          400: { description: 'Insufficient stock or invalid parameters' },
        },
      },
    },
    '/transactions/bulk': {
      post: {
        tags: ['Transactions'],
        summary: 'Execute Multiple Movement Transactions in Batch',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { transactions: { type: 'array', items: { $ref: '#/components/schemas/CreateTransactionRequest' } } },
              },
            },
          },
        },
        responses: {
          201: { description: 'Batch transactions recorded successfully' },
          400: { description: 'Batch validation failed' },
        },
      },
    },
    '/transactions/{id}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get Transaction by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } } },
          404: { description: 'Transaction not found' },
        },
      },
      put: {
        tags: ['Transactions'],
        summary: 'Update Transaction Details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { quantity: { type: 'integer' }, notes: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'Transaction updated' },
        },
      },
      delete: {
        tags: ['Transactions'],
        summary: 'Delete Transaction and Revert Stock Balance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Transaction deleted and stock reverted' },
        },
      },
    },
    '/deliveries': {
      get: {
        tags: ['Deliveries'],
        summary: 'List All Inward Supplier Deliveries',
        responses: {
          200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Delivery' } } } } },
        },
      },
      post: {
        tags: ['Deliveries'],
        summary: 'Create New Supplier Delivery & Inward Goods Note',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['seller', 'items'],
                properties: {
                  deliveryId: { type: 'string', example: 'DEL-2026-089' },
                  deliveryDate: { type: 'string', format: 'date-time' },
                  seller: { type: 'string', example: 'Al Futtaim Engineering' },
                  receivedBy: { type: 'string', example: 'Muhammad Rizwan' },
                  invoiceImageUrl: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['itemId', 'quantity'],
                      properties: { itemId: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', example: 10 } },
                    },
                  },
                  remarks: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Delivery recorded and stock incremented' },
        },
      },
    },
    '/deliveries/{id}': {
      get: {
        tags: ['Deliveries'],
        summary: 'Get Inward Delivery Note Details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Delivery' } } } },
          404: { description: 'Delivery not found' },
        },
      },
      delete: {
        tags: ['Deliveries'],
        summary: 'Delete Delivery Note & Reverse Inward Stock',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Delivery deleted and stock updated' },
        },
      },
    },
    '/sites': {
      get: {
        tags: ['Sites'],
        summary: 'List All Active Construction Sites & Warehouses',
        responses: {
          200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Site' } } } } },
        },
      },
      post: {
        tags: ['Sites'],
        summary: 'Add New Project Site',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['siteCode', 'siteName'],
                properties: {
                  siteCode: { type: 'string', example: 'AUH-04' },
                  siteName: { type: 'string', example: 'Yas Island Commercial Tower' },
                  location: { type: 'string', example: 'Yas Island, Abu Dhabi' },
                  status: { type: 'string', example: 'active' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Site registered successfully' },
        },
      },
    },
    '/sites/{id}': {
      get: {
        tags: ['Sites'],
        summary: 'Get Site Profile by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Site' } } } },
        },
      },
      put: {
        tags: ['Sites'],
        summary: 'Update Site Information',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { siteName: { type: 'string' }, location: { type: 'string' }, status: { type: 'string' } } },
            },
          },
        },
        responses: {
          200: { description: 'Site updated' },
        },
      },
      delete: {
        tags: ['Sites'],
        summary: 'Delete Site',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Site deleted' },
        },
      },
    },
    '/sites/{id}/items': {
      get: {
        tags: ['Sites'],
        summary: 'Get All Current Items & Holdings Stationed at Specific Site',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'List of items at this site with net quantities',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } } } },
          },
        },
      },
    },
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List All Employees and Staff Members',
        responses: {
          200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } },
        },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get Employee Profile by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        },
      },
      put: {
        tags: ['Users'],
        summary: 'Update Employee Profile / Role / Active Status',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { fullName: { type: 'string' }, role: { type: 'string' }, isActive: { type: 'boolean' } } },
            },
          },
        },
        responses: {
          200: { description: 'User updated successfully' },
        },
      },
      delete: {
        tags: ['Users'],
        summary: 'Deactivate / Delete Employee',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'User deleted' },
        },
      },
    },
    '/users/{id}/items': {
      get: {
        tags: ['Users'],
        summary: 'Get All Company Equipment & Tools in Custody of Specific Employee',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'List of items in employee custody',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/InventoryItem' } } } },
          },
        },
      },
    },
    '/vendors': {
      get: {
        tags: ['Vendors'],
        summary: 'List All Suppliers and Vendors',
        responses: {
          200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Vendor' } } } } },
        },
      },
      post: {
        tags: ['Vendors'],
        summary: 'Register New Vendor / Supplier',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'Hilti Emirates LLC' },
                  contactPerson: { type: 'string', example: 'Mark Davis' },
                  email: { type: 'string', example: 'orders@hilti.ae' },
                  phone: { type: 'string', example: '+971480044584' },
                  address: { type: 'string', example: 'Al Quoz, Dubai' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Vendor created successfully' },
        },
      },
    },
    '/vendors/{id}': {
      get: {
        tags: ['Vendors'],
        summary: 'Get Vendor Details by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Vendor' } } } },
        },
      },
      put: {
        tags: ['Vendors'],
        summary: 'Update Vendor Profile',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { contactPerson: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } },
            },
          },
        },
        responses: {
          200: { description: 'Vendor updated' },
        },
      },
      delete: {
        tags: ['Vendors'],
        summary: 'Delete Vendor',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Vendor deleted' },
        },
      },
    },
    '/uploads': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload Image or PDF Receipt to Cloudinary CDN',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary', description: 'Image or PDF binary' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Uploaded successfully',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { cloudinaryUrl: { type: 'string', example: 'https://res.cloudinary.com/.../receipt.jpg' } } },
              },
            },
          },
          400: { description: 'No file or invalid file type' },
        },
      },
    },
    '/app-config': {
      get: {
        tags: ['App Config'],
        summary: 'Get Global Dynamic System Configuration & Company Profile',
        security: [],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/AppConfig' } } } },
        },
      },
      put: {
        tags: ['App Config'],
        summary: 'Update System Configuration',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { companyName: { type: 'string' }, companyPhone: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'Config updated successfully' },
        },
      },
    },
  },
};

const options = {
  definition: swaggerDefinition,
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
