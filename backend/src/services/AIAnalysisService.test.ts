import { AIAnalysisService } from './AIAnalysisService';

describe('AIAnalysisService OpenAI configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses OPENAI_API_KEY before request API key', () => {
    process.env.OPENAI_API_KEY = 'openai-key';

    const service = new AIAnalysisService() as any;

    expect(service.getEffectiveAPIKey('request-key')).toBe('openai-key');
    expect(service.hasConfiguredAPIKey()).toBe(true);
  });

  it('falls back to request API key when no environment key is configured', () => {
    delete process.env.OPENAI_API_KEY;

    const service = new AIAnalysisService() as any;

    expect(service.getEffectiveAPIKey('request-key')).toBe('request-key');
  });

  it('uses Responses API style by default', () => {
    delete process.env.OPENAI_API_STYLE;

    const service = new AIAnalysisService() as any;

    expect(service.openAIAPIStyle).toBe('responses');
  });

  it('supports OpenAI-compatible chat completions style for relay services', () => {
    process.env.OPENAI_API_STYLE = 'chat_completions';

    const service = new AIAnalysisService() as any;

    expect(service.openAIAPIStyle).toBe('chat_completions');
  });

  it('supports OPENAI_BASE_URL as an endpoint alias', () => {
    delete process.env.OPENAI_API_ENDPOINT;
    process.env.OPENAI_BASE_URL = 'https://relay.example.com/v1/';

    const service = new AIAnalysisService() as any;

    expect(service.openAIEndpoint).toBe('https://relay.example.com/v1');
  });
});
