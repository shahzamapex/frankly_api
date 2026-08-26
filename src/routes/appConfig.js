const express = require('express');
const { fetchMany, insertRow } = require('../lib/db');
const { getSupabaseAdmin } = require('../lib/supabase');

const router = express.Router();

function defaultAppConfig() {
  return {
    companyName: 'Frankly Built Contracting LLC',
    companyDescription: '',
    companyAddress: 'Dubai, UAE',
    companyPhone: '',
    companyEmail: '',
    companyWebsite: '',
    companyLogo: '',
    headOfficeLocation: '',
    warehouseLocation: '',
    established: '',
    ownerName: '',
    companyFacebook: '',
    companyInstagram: '',
    companyLinkedIn: '',
    companyTwitter: '',
    companyTikTok: '',
    appVersion: '2.4.0',
    appName: 'Frankly',
    appDescription: '',
    aboutPageContent: '',
    features: [],
    privacyPolicy: '',
    termsAndConditions: '',
    faqs: [],
    supportEmail: '',
    supportPhone: '',
    supportWhatsapp: '',
    developerName: '',
    developerEmail: '',
    developerPhone: '',
    developerLinkedIn: '',
    developerGithub: '',
    developerTwitter: '',
    isSingleton: true,
  };
}

router.get('/', async (req, res) => {
  try {
    const configs = await fetchMany('app_configs', {
      filters: [{ column: 'isSingleton', operator: 'eq', value: true }],
      limit: 1,
    });

    let config = configs[0];
    if (!config) {
      config = await insertRow('app_configs', defaultAppConfig());
    }

    const { data: faqs, error } = await getSupabaseAdmin()
      .from('app_config_faqs')
      .select('*')
      .eq('app_config_id', config.id || config._id)
      .order('sort_order', { ascending: true });

    if (error) {
      throw error;
    }

    res.json({
      ...config,
      faqs: (faqs || []).map((faq) => ({
        id: faq.id,
        question: faq.question,
        answer: faq.answer,
        sortOrder: faq.sort_order,
      })),
    });
  } catch (err) {
    console.error('Get app config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
