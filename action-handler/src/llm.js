const axios = require('axios');

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'stub';

/**
 * Call an LLM API with the given prompt.
 * Supports: gemini, groq, openrouter, stub (fallback with artificial delay)
 */
async function callLLM(prompt, config = {}) {
  const provider = config.provider || LLM_PROVIDER;
  const apiKey = config.apiKey || LLM_API_KEY;

  console.log(`[LLM] Provider: ${provider}, Prompt: "${prompt.substring(0, 80)}..."`);

  switch (provider) {
    case 'gemini':
      return callGemini(prompt, apiKey);
    case 'groq':
      return callGroq(prompt, apiKey);
    case 'openrouter':
      return callOpenRouter(prompt, apiKey);
    case 'stub':
    default:
      return callStub(prompt);
  }
}

async function callGemini(prompt, apiKey) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      },
      { timeout: 30000 }
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { response: text, provider: 'gemini', model: 'gemini-1.5-flash' };
  } catch (err) {
    console.error('[LLM] Gemini error:', err.response?.data || err.message);
    throw new Error(`Gemini API error: ${err.message}`);
  }
}

async function callGroq(prompt, apiKey) {
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1024
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    const text = res.data.choices?.[0]?.message?.content || '';
    return { response: text, provider: 'groq', model: 'llama-3.1-8b-instant' };
  } catch (err) {
    console.error('[LLM] Groq error:', err.response?.data || err.message);
    throw new Error(`Groq API error: ${err.message}`);
  }
}

async function callOpenRouter(prompt, apiKey) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1024
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    const text = res.data.choices?.[0]?.message?.content || '';
    return { response: text, provider: 'openrouter', model: 'llama-3-8b-instruct' };
  } catch (err) {
    console.error('[LLM] OpenRouter error:', err.response?.data || err.message);
    throw new Error(`OpenRouter API error: ${err.message}`);
  }
}

async function callStub(prompt) {
  // Artificial delay to simulate real API call (1-3 seconds)
  const delay = 1000 + Math.random() * 2000;
  await new Promise(resolve => setTimeout(resolve, delay));

  // Generate a deterministic-ish stub response based on prompt content
  const lowerPrompt = prompt.toLowerCase();
  let sentiment = 'positive';
  let response = '';

  if (lowerPrompt.includes('review') || lowerPrompt.includes('product')) {
    response = `Here is a product review with positive sentiment:\n\nThe new TechGadget Pro X is an absolute game-changer! The build quality is exceptional, featuring a sleek aluminum chassis that feels premium in hand. The 120Hz AMOLED display delivers stunning visuals with deep blacks and vibrant colors. Battery life easily lasts a full day of heavy use, and the fast-charging capability gets you from 0 to 80% in just 30 minutes. The AI-powered features are genuinely useful, not gimmicky. Overall sentiment: positive. Highly recommended for tech enthusiasts looking for the best-in-class experience.`;
  } else if (lowerPrompt.includes('negative') || lowerPrompt.includes('bad')) {
    sentiment = 'negative';
    response = `Analysis result with negative sentiment:\n\nThe data indicates several concerning trends. Performance metrics have declined by 15% compared to the previous quarter. User engagement is down, and churn rate has increased. Overall sentiment: negative. Immediate action is recommended to address these issues.`;
  } else if (lowerPrompt.includes('summarize') || lowerPrompt.includes('summary')) {
    response = `Summary: The provided data contains key metrics and indicators. The overall trend is positive with moderate growth across primary KPIs. Revenue increased by 12%, user acquisition is up 8%, and retention improved by 3%. The most notable finding is the strong performance in the enterprise segment. Overall sentiment: positive.`;
  } else {
    response = `Based on the provided input, here is my analysis:\n\nThe request has been processed successfully. Key findings include strong performance indicators and positive trajectory across all measured dimensions. The data suggests continued growth and improvement. Overall sentiment: positive.\n\nRecommendation: Continue with the current strategy while monitoring for emerging trends.`;
  }

  console.log(`[LLM] Stub response generated (${delay.toFixed(0)}ms delay, sentiment: ${sentiment})`);
  return { response, provider: 'stub', model: 'stub-v1', sentiment };
}

module.exports = { callLLM };
