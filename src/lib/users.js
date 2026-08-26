function generateUsername(firstName, lastName) {
  let baseUsername = '';
  if (lastName) {
    baseUsername = lastName.toLowerCase();
  } else if (firstName) {
    baseUsername = firstName.toLowerCase();
  } else {
    baseUsername = 'user';
  }

  baseUsername = baseUsername.replace(/[^a-z0-9]/g, '');
  const randomNum = Math.floor(Math.random() * 90) + 10;
  return `${baseUsername}${randomNum}`;
}

function buildFullName(user) {
  if (user.fullName) {
    return user.fullName;
  }
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || undefined;
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const sanitized = { ...user };
  const recordId = sanitized._id ?? sanitized.id;
  delete sanitized.password;

  return {
    ...sanitized,
    _id: recordId ? String(recordId) : sanitized._id,
    id: recordId ? String(recordId) : sanitized.id,
    fullName: buildFullName(sanitized),
    isActive: sanitized.isActive !== false,
    role: sanitized.role || 'emp',
    permission: sanitized.permission === true || sanitized.permission === 'true' || sanitized.permission === 1,
    salaryCurrency: sanitized.salaryCurrency || 'AED',
  };
}

function filterUserRow(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const cleaned = {};

  const mappings = {
    id: 'id',
    _id: 'id',
    username: 'username',
    role: 'role',
    permission: 'permission',
    email: 'email',
    mobile: 'mobile',
    phone: 'phone',
    employeeId: 'employee_id',
    employee_id: 'employee_id',
    fullName: 'full_name',
    full_name: 'full_name',
    isActive: 'is_active',
    is_active: 'is_active',
    salary: 'salary',
    salaryCurrency: 'salary_currency',
    salary_currency: 'salary_currency',
    country: 'country',
    department: 'department',
    emergencyContact: 'emergency_contact',
    emergency_contact: 'emergency_contact',
    joiningDate: 'joining_date',
    joining_date: 'joining_date',
    dateOfBirth: 'date_of_birth',
    date_of_birth: 'date_of_birth',
    emiratesIdExpiryDate: 'emirates_id_expiry_date',
    emirates_id_expiry_date: 'emirates_id_expiry_date',
    emiratesIdNumber: 'emirates_id_number',
    emirates_id_number: 'emirates_id_number',
    passportNumber: 'passport_number',
    passport_number: 'passport_number',
    profilePictureUrl: 'profile_picture_url',
    profile_picture_url: 'profile_picture_url',
    lastLoginAt: 'last_login_at',
    last_login_at: 'last_login_at',
    createdAt: 'created_at',
    created_at: 'created_at',
    updatedAt: 'updated_at',
    updated_at: 'updated_at',
  };

  if (!payload.fullName && !payload.full_name) {
    const derived = buildFullName(payload);
    if (derived) {
      cleaned.full_name = derived;
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const dbCol = mappings[key];
    if (dbCol) {
      cleaned[dbCol] = value;
    }
  }

  return cleaned;
}

module.exports = {
  buildFullName,
  filterUserRow,
  generateUsername,
  sanitizeUser,
};
