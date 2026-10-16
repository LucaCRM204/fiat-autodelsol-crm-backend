const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

const validatePhone = (phone) => {
  const re = /^\+?[\d\s\-\(\)]{10,}$/;
  return re.test(phone);
};

const validateRole = (role, userRole) => {
  const roleHierarchy = {
    'owner': ['director', 'gerente', 'supervisor', 'vendedor'],
    'director': ['gerente', 'supervisor', 'vendedor'],
    'gerente': ['supervisor', 'vendedor']
  };
  return roleHierarchy[userRole] && roleHierarchy[userRole].includes(role);
};

const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '');
};

module.exports = { validateEmail, validatePhone, validateRole, sanitizeInput };
