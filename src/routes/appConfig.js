const express = require('express');

const router = express.Router();

const appConfigData = {
  id: '1fb1067a-6e33-4eac-9b2d-34dc1722fd31',
  appName: 'Frankly',
  appVersion: '3.1',
  companyName: 'Frankly Built Contracting LLC',
  ownerName: 'Francois Tarabay, CEO',
  established: '2025',
  companyAddress: 'Dubai, UAE',
  headOfficeLocation: 'Aspect Tower - Office 1305 - Business Bay - Dubai',
  warehouseLocation: 'X5CR+XG6 - Dubai Investment Park - 2 - Dubai',
  companyPhone: '+971 50 136 8438',
  companyEmail: 'admin@frankly.ae',
  companyWebsite: 'https://frankly.ae/',
  companyLogo: 'https://res.cloudinary.com/daoummcel/image/upload/v1774943434/logo_oqzyhe.png',
  supportEmail: 'dev.shahzama@gmail.com',
  supportPhone: '+971-56-6602242',
  supportWhatsapp: '+971-56-6602242',
  developerName: 'Shahzama Ahmad',
  developerEmail: 'dev.shahzama@gmail.com',
  developerPhone: '+971-52-6114643',
  developerGithub: 'https://github.com/shahzamapex',
  companyInstagram: 'https://www.instagram.com/franklybuiltcontracting',
  companyLinkedIn: 'https://www.linkedin.com/company/franklybuilt/',
  companyTikTok: 'https://www.tiktok.com/@franklybuiltcontracting',
  companyDescription:
    'Frankly Built Contracting LLC is a leading construction and contracting company based in Dubai, UAE. We specialize in delivering high-quality construction projects, infrastructure development, and comprehensive contracting solutions.',
  appDescription:
    'A comprehensive warehouse management system designed to streamline construction operations through efficient inventory control, employee management, site monitoring, and GPS-enabled attendance tracking.',
  aboutPageContent:
    'Frankly is a full-featured warehouse management system built specifically for construction and contracting operations. The application provides real-time inventory tracking, employee attendance monitoring with GPS verification, site-specific item management, and comprehensive reporting capabilities. With role-based access control and multi-user support, teams can collaborate efficiently while maintaining security and accountability.',
  features: [
    'Dashboard with Real-time Statistics',
    'Inventory Management (Add, Edit, Delete, View)',
    'Transaction Tracking (Issue/Return)',
    'Site Management with Item Tracking',
    'GPS-enabled Attendance System',
    'Delivery Management',
    'CSV/PDF Export for Reports',
    'Role-based Access Control',
    'Asset Assignment to Employees',
    'Image Upload with CDN Support',
  ],
  faqs: [
    {
      question: 'Why am I not able to perform operations (Add/Edit/Delete Transactions, Inventory, Sites)?',
      answer:
        'Write operations in Frankly Warehouse Manager require either an Admin role or active Operations Permission (permission: true). Non-admin accounts without this permission have View-Only access to protect records. If you need operational access, ask a system administrator to enable the "Operations Permission" switch on your account in Employee Management.',
    },
    {
      question: 'How do I check if I have Operations Permission?',
      answer:
        'Check the top hero card on your My Profile or Settings screen. If you see the 🛡️ "Full Operations" badge, you have full write access. If you see 🔒 "View Only", your account is in read-only mode.',
    },
    {
      question: 'How do I record a site dispatch or item checkout?',
      answer:
        'From the Home Screen or Transactions tab, tap "Add Trans", select "DISPATCH / CHECKOUT", pick the source warehouse, pick the destination site, and specify the items and quantities.',
    },
    {
      question: 'How does offline mode work when I have no internet on site?',
      answer:
        'All transactions, movements, and item scans are queued locally and encrypted on your device. Once your device reconnects to Wi-Fi or cellular data, the app syncs all queued changes automatically to Supabase.',
    },
    {
      question: 'How do I generate and export PDF transaction vouchers?',
      answer:
        'Open any transaction or delivery record and tap the "PDF / Print" button in the upper action bar to preview, download, or share the official company voucher.',
    },
    {
      question: 'How does the Construction Calculator estimate materials?',
      answer:
        'Access the Calculator shortcut on the Home Screen to compute concrete volume, brick counts, plaster bags, steel weights, and tile layouts using standard metric and imperial formulas.',
    },
  ],
  isSingleton: true,
};

router.get('/', (req, res) => {
  res.json(appConfigData);
});

module.exports = router;
