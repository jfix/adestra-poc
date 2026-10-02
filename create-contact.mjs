const { 
    ADESTRA_API_TOKEN, 
    ADESTRA_TABLE_ID, 
    ADESTRA_TEST_EMAIL, 
    ADESTRA_LIST_ID, 
    ADESTRA_FIRST_NAME, 
    ADESTRA_LAST_NAME,
    ADESTRA_TITLE,
    ADESTRA_LANGUAGE,
    ADESTRA_SOURCE_PATH
} = process.env;

if (!ADESTRA_API_TOKEN || 
    !ADESTRA_TABLE_ID || 
    !ADESTRA_TEST_EMAIL) 
{
  console.error('Missing one or more required environment variables in .env');
  process.exit(1);
}

if (ADESTRA_LANGUAGE && !['en', 'fr'].includes(ADESTRA_LANGUAGE)) {
  console.error('ADESTRA_LANGUAGE must be en or fr');
  process.exit(1);
}
if (ADESTRA_SOURCE_PATH && ADESTRA_SOURCE_PATH.length > 1024) {
  console.error('ADESTRA_SOURCE_PATH must not exceed 1024 characters');
  process.exit(1);
}

const body = {
  table_id: Number(ADESTRA_TABLE_ID),
  contact_data: { 
    email: ADESTRA_TEST_EMAIL, 
    first_name: ADESTRA_FIRST_NAME, 
    last_name: ADESTRA_LAST_NAME,
    title: ADESTRA_TITLE,
    ...(ADESTRA_LANGUAGE ? { language: ADESTRA_LANGUAGE } : {}),
    ...(ADESTRA_SOURCE_PATH ? { source_path: ADESTRA_SOURCE_PATH } : {})
  },
  options: { list_id: Number(ADESTRA_LIST_ID) },
};

const res = await fetch('https://app.adestra.com/api/rest/1/contacts', {
  method: 'POST',
  headers: {
    Authorization: `TOKEN ${ADESTRA_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

console.log(res.status, res.statusText);
console.log(await res.text());
