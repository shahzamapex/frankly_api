const { fetchOne, hasColumn, insertRow, updateRow } = require('./db');
const { getSupabaseAdmin, getSupabaseAuth } = require('./supabase');
const { buildFullName, filterUserRow, sanitizeUser } = require('./users');

const AUTH_LINK_COLUMNS = ['authUserId', 'auth_user_id', 'supabaseAuthId', 'supabase_auth_id'];

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSupabaseFallbackEmailDomain() {
  const domain = process.env.SUPABASE_AUTH_FALLBACK_EMAIL_DOMAIN;
  return typeof domain === 'string' ? domain.trim().toLowerCase() : '';
}

function buildAuthEmail(userData = {}) {
  const directEmail = normalizeEmail(userData.email);
  if (directEmail) {
    return directEmail;
  }

  const username = normalizeUsername(userData.username);
  const domain = getSupabaseFallbackEmailDomain();
  if (!username || !domain) {
    return '';
  }

  const safeLocalPart = username
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^\.+|\.+$/g, '');

  return safeLocalPart ? `${safeLocalPart}@${domain}` : '';
}

async function findUserByColumn(column, value) {
  if (!value || !await hasColumn('users', column)) {
    return null;
  }

  return fetchOne('users', {
    filters: [{ column, operator: 'eq', value }],
  });
}

async function getAuthLinkColumn() {
  for (const column of AUTH_LINK_COLUMNS) {
    if (await hasColumn('users', column)) {
      return column;
    }
  }

  return null;
}

async function listAuthUsers() {
  const { data, error } = await getSupabaseAdmin().auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) {
    throw error;
  }

  return data?.users || [];
}

async function findAuthUserIdForLocalUser(localUser) {
  const linkedUserId = localUser?.authUserId || localUser?.auth_user_id || localUser?.supabaseAuthId || localUser?.supabase_auth_id;
  if (linkedUserId) {
    return linkedUserId;
  }

  const candidateEmails = uniqueValues([
    normalizeEmail(localUser?.email),
    buildAuthEmail(localUser),
  ]);

  if (!candidateEmails.length && !localUser?.username) {
    return '';
  }

  const users = await listAuthUsers();
  const matched = users.find((authUser) => {
    const authEmail = normalizeEmail(authUser.email);
    const metadataUsername = normalizeUsername(authUser.user_metadata?.username);
    return candidateEmails.includes(authEmail)
      || (localUser?.username && metadataUsername === normalizeUsername(localUser.username));
  });

  return matched?.id || '';
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function buildUsernameBase(value) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = source.replace(/[^a-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '');
  return normalized || 'user';
}

async function generateAvailableUsername(authUser) {
  const metadataUsername = normalizeUsername(authUser?.user_metadata?.username);
  const emailBase = buildUsernameBase(normalizeEmail(authUser?.email).split('@')[0]);
  const baseUsername = buildUsernameBase(metadataUsername || emailBase);

  let candidate = baseUsername;
  let suffix = 1;
  while (await findUserByColumn('username', candidate)) {
    suffix += 1;
    candidate = `${baseUsername}${suffix}`;
  }

  return candidate;
}

async function syncAuthLink(user, authUser) {
  if (!user || !authUser) {
    return user;
  }

  const updates = {};
  const authLinkColumn = await getAuthLinkColumn();

  if (authLinkColumn && user[authLinkColumn] !== authUser.id) {
    updates[authLinkColumn] = authUser.id;
  }

  if (authUser.email && await hasColumn('users', 'email') && !user.email) {
    updates.email = authUser.email;
  }

  if (
    authUser.user_metadata?.username &&
    await hasColumn('users', 'username') &&
    !user.username
  ) {
    updates.username = authUser.user_metadata.username;
  }

  if (!Object.keys(updates).length) {
    return user;
  }

  return updateRow('users', user._id || user.id, updates);
}

async function createProfileFromAuthUser(authUser) {
  if (!authUser?.email) {
    return null;
  }

  const authLinkColumn = await getAuthLinkColumn();
  const username = await generateAvailableUsername(authUser);
  const payload = {
    id: authUser.id,
    username,
    email: normalizeEmail(authUser.email),
    fullName: authUser.user_metadata?.fullName
      || authUser.user_metadata?.full_name
      || username,
    role: authUser.user_metadata?.role || 'user',
    phone: authUser.phone || null,
    mobile: authUser.phone || null,
    isActive: true,
    salaryCurrency: 'AED',
  };

  if (authLinkColumn) {
    payload[authLinkColumn] = authUser.id;
  }

  return insertRow('users', payload);
}

async function findUserForAuthUser(authUser) {
  if (!authUser) {
    return null;
  }

  const authLinkColumn = await getAuthLinkColumn();
  let user = null;

  if (authLinkColumn) {
    user = await findUserByColumn(authLinkColumn, authUser.id);
  }

  if (!user && authUser.email) {
    user = await findUserByColumn('email', authUser.email);
  }

  if (!user && authUser.user_metadata?.username) {
    user = await findUserByColumn('username', authUser.user_metadata.username);
  }

  if (!user && authUser.phone) {
    user = await findUserByColumn('phone', authUser.phone)
      || await findUserByColumn('mobile', authUser.phone);
  }

  if (!user) {
    user = await createProfileFromAuthUser(authUser);
  }

  return syncAuthLink(user, authUser);
}

async function ensureUserDoesNotExist(username, email) {
  const existingByUsername = username ? await findUserByColumn('username', username) : null;
  if (existingByUsername) {
    return { exists: true, message: 'Username already exists' };
  }

  const existingByEmail = email ? await findUserByColumn('email', email) : null;
  if (existingByEmail) {
    return { exists: true, message: 'Email already exists' };
  }

  return { exists: false };
}

async function createLinkedUserProfile(profile, authUser) {
  const authEmail = normalizeEmail(authUser?.email || profile.email);
  const fullName = profile.fullName || profile.name || buildFullName(profile);
  const authLinkColumn = await getAuthLinkColumn();
  const payload = {
    ...profile,
    id: authUser?.id,
    email: authEmail || profile.email,
    phone: profile.phone || profile.mobile,
    mobile: profile.mobile || profile.phone,
    fullName,
    role: profile.role || 'emp',
    isActive: profile.isActive !== false,
    salaryCurrency: profile.salaryCurrency || 'AED',
  };

  const filtered = filterUserRow(payload);

  if (authLinkColumn && authUser?.id && !filtered[authLinkColumn]) {
    filtered[authLinkColumn] = authUser.id;
  }

  return insertRow('users', filtered);
}

function formatSessionPayload(session, user) {
  if (!session) {
    return {
      user: sanitizeUser(user),
    };
  }
  return {
    token: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    user: sanitizeUser(user),
  };
}

async function verifyAccessToken(token) {
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    throw error || new Error('Invalid Supabase access token');
  }

  const user = sanitizeUser(await findUserForAuthUser(data.user));
  if (!user) {
    throw new Error('User profile not found');
  }

  return { authUser: data.user, user };
}

async function signInWithPassword(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { error: { message: 'Email is required to sign in' } };
  }

  const authUserProfile = await findUserByColumn('email', normalizedEmail);
  if (authUserProfile && authUserProfile.isActive === false) {
    return { error: new Error('Account is deactivated') };
  }

  const emailToUse = normalizedEmail;

  const { data, error } = await getSupabaseAuth().auth.signInWithPassword({
    email: emailToUse,
    password,
  });

  if (error || !data?.session || !data.user) {
    return { error: error || new Error('Unable to sign in') };
  }

  const user = sanitizeUser(await findUserForAuthUser(data.user));
  if (!user) {
    return { error: new Error('User profile not found') };
  }

  return {
    session: data.session,
    authUser: data.user,
    user,
  };
}

async function refreshAccessToken(refreshToken) {
  const { data, error } = await getSupabaseAuth().auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data?.session || !data.user) {
    throw error || new Error('Unable to refresh Supabase session');
  }

  const user = sanitizeUser(await findUserForAuthUser(data.user));
  if (!user) {
    throw new Error('User profile not found');
  }

  return {
    session: data.session,
    authUser: data.user,
    user,
  };
}

async function signOutSession(accessToken) {
  const { error } = await getSupabaseAdmin().auth.admin.signOut(accessToken);
  if (error) {
    throw error;
  }
}

async function createSupabaseAuthUser(profile) {
  const email = buildAuthEmail(profile);
  if (!email) {
    throw new Error('Email is required for Supabase Auth. Add email or configure SUPABASE_AUTH_FALLBACK_EMAIL_DOMAIN.');
  }

  const metadata = {
    username: normalizeUsername(profile.username),
    fullName: profile.fullName || profile.name || buildFullName(profile),
    role: profile.role || 'emp',
  };

  const { data, error } = await getSupabaseAdmin().auth.admin.createUser({
    email,
    password: profile.password,
    email_confirm: true,
    user_metadata: metadata,
  });

  if (error || !data?.user) {
    throw error || new Error('Unable to create Supabase user');
  }

  return { authUser: data.user, email };
}

async function registerUser(profile) {
  const email = buildAuthEmail(profile);
  const username = normalizeUsername(profile.username);
  const duplicateCheck = await ensureUserDoesNotExist(username, email);
  if (duplicateCheck.exists) {
    throw new Error(duplicateCheck.message);
  }

  const { authUser } = await createSupabaseAuthUser(profile);
  const createdUser = await createLinkedUserProfile({ ...profile, email }, authUser);

  let session = null;
  try {
    const signInResult = await signInWithPassword(email, profile.password);
    if (!signInResult.error && signInResult.session) {
      session = signInResult.session;
    }
  } catch (_) {}

  return {
    session,
    authUser,
    user: createdUser,
  };
}

async function updateSupabaseUser(localUser, updates = {}) {
  const authUserId = await findAuthUserIdForLocalUser(localUser);
  if (!authUserId) {
    if (updates.password || updates.email) {
      throw new Error('This user is not linked to a Supabase auth account yet');
    }
    return;
  }

  const nextEmail = normalizeEmail(updates.email || localUser.email);
  const nextUsername = normalizeUsername(updates.username || localUser.username);
  const nextFullName = updates.fullName || localUser.fullName || buildFullName({
    ...localUser,
    ...updates,
  });

  const payload = {};
  if (updates.email) {
    payload.email = nextEmail;
    payload.email_confirm = true;
  }
  if (updates.password) {
    payload.password = updates.password;
  }

  if (updates.username || updates.fullName || updates.role) {
    payload.user_metadata = {
      username: nextUsername,
      fullName: nextFullName,
      role: updates.role || localUser.role || 'emp',
    };
  }

  if (!Object.keys(payload).length) {
    return;
  }

  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(authUserId, payload);
  if (error) {
    throw error;
  }
}

async function deleteSupabaseUser(localUser) {
  const authUserId = await findAuthUserIdForLocalUser(localUser);
  if (!authUserId) {
    return;
  }

  const { error } = await getSupabaseAdmin().auth.admin.deleteUser(authUserId);
  if (error) {
    throw error;
  }
}

async function changePassword(accessToken, currentPassword, newPassword) {
  const { authUser, user } = await verifyAccessToken(accessToken);
  const email = normalizeEmail(authUser.email || user.email);
  if (!email) {
    throw new Error('This account does not have an email address configured');
  }

  const signInResult = await signInWithPassword(email, currentPassword);
  if (signInResult.error) {
    throw new Error('Current password is incorrect');
  }

  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(authUser.id, {
    password: newPassword,
  });
  if (error) {
    throw error;
  }
}

module.exports = {
  changePassword,
  deleteSupabaseUser,
  findUserForAuthUser,
  formatSessionPayload,
  refreshAccessToken,
  registerUser,
  signInWithPassword,
  signOutSession,
  updateSupabaseUser,
  verifyAccessToken,
};
