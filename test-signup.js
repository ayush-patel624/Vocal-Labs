const axios = require('axios');

async function testSignup() {
  try {
    const res = await axios.post('http://localhost:3001/auth/signup', {
      name: 'Test Sign Up User',
      email: 'testsignup@example.com',
      password: 'password123'
    });
    console.log('Success:', res.data);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}
testSignup();
