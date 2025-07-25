import type { Config, Provider } from '../types';
import type { VideoAnalysisOptions } from '../types';
import { loadConfig, loadEnv } from '../config';
import OpenAI, { BadRequestError } from 'openai';
import { ApiKeyMissingError, ModelNotFoundError, NetworkError, ProviderError } from '../errors';
import { exhaustiveMatchGuard } from '../utils/exhaustiveMatchGuard';
import { chunkMessage } from '../utils/messageChunker';
import Anthropic from '@anthropic-ai/sdk';
import { stringSimilarity, getSimilarModels } from '../utils/stringSimilarity';
import { GoogleAuth } from 'google-auth-library';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { once } from '../utils/once';
import { getAllProviders } from '../utils/providerAvailability';
import { isModelNotFoundError } from './notFoundErrors';

const TEN_MINUTES = 600000;
// Interfaces for Gemini response types
interface GeminiGroundingChunk {
  web?: {
    uri: string;
    title?: string;
  };
}

interface GeminiGroundingSupport {
  segment: {
    startIndex?: number;
    endIndex?: number;
    text: string;
  };
  groundingChunkIndices: number[];
  confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
  groundingChunks: GeminiGroundingChunk[];
  groundingSupports: GeminiGroundingSupport[];
  webSearchQueries?: string[];
}

// Request body types for Google APIs
interface GoogleVertexAIRequestBody {
  contents: { role: string; parts: { text: string }[] }[];
  generationConfig: { maxOutputTokens: number };
  system_instruction?: { parts: { text: string }[] };
  tools?: { google_search: Record<string, never> }[];
}

interface GoogleGenerativeLanguageRequestBody {
  contents: { parts: { text: string }[] }[];
  generationConfig: { maxOutputTokens: number };
  system_instruction?: { parts: { text: string }[] };
  tools?: { google_search: Record<string, never> }[];
}

// Common options for all providers
export interface ModelOptions {
  model: string;
  maxTokens: number;
  systemPrompt?: string;
  tokenCount?: number; // For handling large token counts
  webSearch?: boolean; // Whether to enable web search capabilities
  timeout?: number; // Timeout in milliseconds for model API calls
  debug: boolean | undefined; // Enable debug logging
  reasoningEffort?: 'low' | 'medium' | 'high'; // Support for o1 and o3-mini reasoning effort
}

// Provider configuration in Config
export interface ProviderConfig {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  // OpenRouter-specific fields
  referer?: string;
  appName?: string;
  // Debug logging config
  debugLogMaxLength?: number; // Maximum length for debug log messages from this provider (in characters)
}

// Base provider interface that all specific provider interfaces will extend
export interface BaseModelProvider {
  executePrompt(prompt: string, options?: ModelOptions): Promise<string>;
  supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }>;
  // Add DETAILED token usage tracking
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  // Add this optional method for video analysis
  executeVideoPrompt?(prompt: string, options: VideoAnalysisOptions): Promise<string>;
  getDefaultMaxTokens?(): number;
}

// Base provider class with common functionality
export abstract class BaseProvider implements BaseModelProvider {
  abstract provider: Provider;
  protected config: Config;
  protected availableModels?: Promise<Set<string>>;
  // Add DETAILED token usage tracking
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  constructor() {
    loadEnv();
    this.config = loadConfig();
  }

  /**
   * Resolves a model name to an available model from the provider.
   * This method implements a multi-step resolution process:
   * 1. Try exact match with provider prefix
   * 2. Try exact match within any provider namespace
   * 3. Try prefix matching with various provider prefixes
   * 4. Try handling special suffixes like -latest or -exp
   * 5. Try finding similar models based on string similarity
   *
   * If no match is found, it throws a ModelNotFoundError with helpful suggestions.
   *
   * @param options The model options containing the requested model name
   * @returns The resolved model name that can be used with the provider's API
   * @throws ModelNotFoundError if no matching model is found
   */
  protected async getModel(options: ModelOptions | undefined): Promise<string> {
    if (!options?.model) {
      throw new ModelNotFoundError(this.provider, (await this.availableModels) ?? null);
    }

    // Handle token count if provided
    if (options?.tokenCount) {
      const { model: tokenModel, error } = this.handleLargeTokenCount(options.tokenCount);
      if (error) {
        throw new ProviderError(error);
      }
      if (tokenModel) {
        if (tokenModel !== options.model) {
          console.log(
            `Using ${tokenModel} instead of ${options.model} to support ${options.tokenCount} tokens.`
          );
        }
        options = { ...options, model: tokenModel };
      }
    }

    const model = options.model;

    // If models aren't initialized yet, return the requested model as-is
    if (!this.availableModels) {
      return model;
    }

    const availableModels = await this.availableModels;
    const modelWithoutPrefix = model.includes('/') ? model.split('/')[1] : model;

    // Try each resolution strategy in sequence
    const resolvedModel =
      this.tryExactMatch(model, availableModels) ||
      this.tryProviderNamespaceMatch(model, modelWithoutPrefix, availableModels) ||
      this.tryPrefixMatch(model, modelWithoutPrefix, availableModels) ||
      this.trySuffixHandling(model, availableModels) ||
      this.tryExperimentalSuffixHandling(model, availableModels);

    if (resolvedModel) {
      return resolvedModel;
    }

    // If all resolution attempts fail, try to find similar models
    const similarModels = this.findSimilarModels(model, modelWithoutPrefix, availableModels);

    // If we found similar models, check if any contain the exact model string
    if (similarModels.length > 0) {
      // Check if the first similar model contains our exact model string

      if (similarModels[0].includes(model)) {
        console.log(
          `[${this.constructor.name}] Model '${model}' not found. Using similar model '${similarModels[0]}' that contains requested model string.`
        );
        return similarModels[0];
      }

      throw new ModelNotFoundError(
        this.provider,
        new Set(similarModels.length > 0 ? similarModels : availableModels),
        this.constructor.name === 'ModelBoxProvider' ||
        this.constructor.name === 'OpenRouterProvider'
          ? " Note: This provider requires provider prefixes (e.g., 'openai/gpt-4.1' instead of just 'gpt-4.1')."
          : ''
      );
    }

    // If no similar models found, show all available models sorted by recency
    const recentModels = Array.from(availableModels).sort((a: string, b: string) =>
      b.localeCompare(a)
    ); // Sort in descending order

    throw new ModelNotFoundError(
      this.provider,
      new Set(recentModels),
      this.constructor.name === 'ModelBoxProvider' || this.constructor.name === 'OpenRouterProvider'
        ? " Note: This provider requires provider prefixes (e.g., 'openai/gpt-4.1' instead of just 'gpt-4.1')."
        : ''
    );
  }

  /**
   * Try to find an exact match for the model in the available models.
   * @param model The requested model name
   * @param availableModels Set of available models
   * @returns The matched model name or undefined if no match found
   */
  private tryExactMatch(model: string, availableModels: Set<string>): string | undefined {
    if (availableModels.has(model)) {
      return model;
    }
    return undefined;
  }

  /**
   * Try to find a match for the model within any provider namespace.
   * @param model The requested model name
   * @param modelWithoutPrefix The model name without provider prefix
   * @param availableModels Set of available models
   * @returns The matched model name or undefined if no match found
   */
  private tryProviderNamespaceMatch(
    model: string,
    modelWithoutPrefix: string,
    availableModels: Set<string>
  ): string | undefined {
    const exactMatchWithProvider = Array.from(availableModels).find((m) => {
      const parts = m.split('/');
      return parts.length >= 2 && parts[1] === modelWithoutPrefix;
    });

    if (exactMatchWithProvider) {
      console.log(
        `[${this.constructor.name}] Using fully qualified model name '${exactMatchWithProvider}' for '${model}'.`
      );
      return exactMatchWithProvider;
    }
    return undefined;
  }

  /**
   * Try to find a match using various prefix matching strategies.
   * @param model The requested model name
   * @param modelWithoutPrefix The model name without provider prefix
   * @param availableModels Set of available models
   * @returns The matched model name or undefined if no match found
   */
  private tryPrefixMatch(
    model: string,
    modelWithoutPrefix: string,
    availableModels: Set<string>
  ): string | undefined {
    const matchingModels = Array.from(availableModels).filter(
      (m) =>
        m === model || // Exact match with prefix
        m.startsWith(`openai/${model}`) || // Try with openai prefix (allow for versions like openai/o3-mini-v1)
        m.endsWith(`/${modelWithoutPrefix}`) || // Match with any prefix
        m === modelWithoutPrefix // Exact match without prefix
    );

    if (matchingModels.length > 0) {
      const resolvedModel = matchingModels[0];
      console.log(
        `[${this.constructor.name}] Using prefix match '${resolvedModel}' for '${model}'.`
      );
      return resolvedModel;
    }
    return undefined;
  }

  /**
   * Try to handle models with -latest suffix by finding the latest version.
   * @param model The requested model name
   * @param availableModels Set of available models
   * @returns The matched model name or undefined if no match found
   */
  private trySuffixHandling(model: string, availableModels: Set<string>): string | undefined {
    if (model.endsWith('-latest')) {
      const modelWithoutLatest = model.slice(0, -'-latest'.length);
      const latestMatches = Array.from(availableModels)
        .filter((m: string) => m.startsWith(modelWithoutLatest))
        .sort((a: string, b: string) => b.localeCompare(a));

      if (latestMatches.length > 0) {
        const resolvedModel = latestMatches[latestMatches.length - 1];
        console.log(
          `[${this.constructor.name}] Model '${model}' not found. Using latest match '${resolvedModel}'.`
        );
        return resolvedModel;
      }
    }
    return undefined;
  }

  /**
   * Try to handle models with -exp or -exp-* suffix by finding a non-experimental version.
   * @param model The requested model name
   * @param availableModels Set of available models
   * @returns The matched model name or undefined if no match found
   */
  private tryExperimentalSuffixHandling(
    model: string,
    availableModels: Set<string>
  ): string | undefined {
    const expMatch = model.match(/^(.*?)(?:-exp(?:-.*)?$)/);
    if (expMatch) {
      const modelWithoutExp = expMatch[1];
      const expMatches = Array.from(availableModels)
        .filter((m: string) => m.startsWith(modelWithoutExp))
        .sort((a: string, b: string) => b.localeCompare(a));

      if (expMatches.length > 0) {
        const resolvedModel = expMatches[expMatches.length - 1];
        console.log(
          `[${this.constructor.name}] Model '${model}' not found. Using non-experimental match '${resolvedModel}'.`
        );
        return resolvedModel;
      }
    }
    return undefined;
  }

  /**
   * Find similar models based on string similarity.
   * @param model The requested model name
   * @param modelWithoutPrefix The model name without provider prefix
   * @param availableModels Set of available models
   * @returns Array of similar model names
   */
  private findSimilarModels(
    model: string,
    modelWithoutPrefix: string,
    availableModels: Set<string>
  ): string[] {
    return getSimilarModels(model, availableModels);
  }

  protected getSystemPrompt(options?: ModelOptions): string | undefined {
    return (
      `Date: ${new Date().toISOString().split('T')[0]}\n` +
      (options?.systemPrompt || 'You are a helpful assistant. Provide clear and concise responses.')
    );
  }

  protected logRequestStart(
    options: ModelOptions,
    model: string,
    maxTokens: number,
    systemPrompt: string | undefined,
    endpoint: string,
    headers?: Record<string, string>
  ): void {
    this.debugLog(options, `Executing prompt with model: ${model}, maxTokens: ${maxTokens}`);
    this.debugLog(options, `API endpoint: ${endpoint}`);
    if (headers) {
      this.debugLog(options, 'Request headers:', this.truncateForLogging(headers));
    }
    if (systemPrompt) {
      this.debugLog(options, 'System prompt:', this.truncateForLogging(systemPrompt));
    }
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    return {}; // Default implementation - no token count handling
  }

  protected debugLog(options: ModelOptions | undefined, message: string, ...args: any[]): void {
    if (options?.debug) {
      console.log(`[${this.constructor.name}] ${message}`, ...args);
    }
  }

  protected truncateForLogging(obj: any, maxLength?: number): string {
    const defaultMaxLength = 500;
    const configMaxLength = (this.config as Record<string, any>)[
      this.constructor.name.toLowerCase()
    ]?.debugLogMaxLength;
    const effectiveMaxLength = maxLength ?? configMaxLength ?? defaultMaxLength;

    const str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    if (str.length <= effectiveMaxLength) return str;
    const keys =
      typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).join(', ') : null;
    return str.slice(0, effectiveMaxLength) + '... (truncated)]' + (keys ? '\nKeys: ' + keys : '');
  }

  /**
   * Determines if the given model supports the reasoning effort parameter.
   * Also checks the OVERRIDE_SAFETY_CHECKS environment variable to allow bypassing model restrictions.
   */
  protected doesModelSupportReasoningEffort(model: string): boolean {
    // If OVERRIDE_SAFETY_CHECKS is set, allow reasoning effort on any model
    const safetyOverride = process.env.OVERRIDE_SAFETY_CHECKS?.toLowerCase();
    if (safetyOverride === 'true' || safetyOverride === '1') {
      return true;
    }

    // Extract model name without provider prefix if present
    const modelWithoutPrefix = model.includes('/') ? model.split('/')[1] : model;

    // OpenAI models that support reasoning effort
    const openAIModelsSupported = modelWithoutPrefix.startsWith('o') || model.startsWith('o');

    // Claude models that support extended thinking
    const claudeModelsSupported =
      modelWithoutPrefix.includes('claude-opus-4') ||
      modelWithoutPrefix.includes('claude-sonnet-4') ||
      model.includes('claude-opus-4') ||
      model.includes('claude-sonnet-4');

    return openAIModelsSupported || claudeModelsSupported;
  }

  // Set token usage helper method for derived classes
  protected setTokenUsage(promptTokens: number, completionTokens: number): void {
    this.tokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };

    // Log token usage when debug is enabled
    // Keep this log for debugging provider implementations
    console.log(
      `[${this.constructor.name}] Token usage set: ${promptTokens} prompt + ${completionTokens} completion = ${this.tokenUsage.totalTokens} total`
    );
  }

  protected abstract webSearchParameters(requestParams: Record<string, any>): Record<string, any>;

  abstract supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }>;
  abstract executePrompt(prompt: string, options: ModelOptions): Promise<string>;
  // Add executeVideoPrompt as optional here as well if not already present
  executeVideoPrompt?(prompt: string, options: VideoAnalysisOptions): Promise<string>;
  getDefaultMaxTokens?(): number;
}

// Helper function for exponential backoff retry
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 5,
  baseDelay: number = 1000, // 1 second
  shouldRetry: (error: any) => boolean = () => true
): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

// Base class for OpenAI-compatible providers (OpenAI and OpenRouter)
abstract class OpenAIBase extends BaseProvider {
  protected defaultClient: OpenAI;
  protected webSearchClient: OpenAI;

  constructor(
    apiKey: string,
    baseURL?: string,
    options?: { defaultHeaders?: Record<string, string> },
    webSearchOptions?: { baseURL?: string; defaultHeaders?: Record<string, string> }
  ) {
    super();
    this.defaultClient = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      defaultHeaders: options?.defaultHeaders,
    });
    // Use the same client for web search by default
    this.webSearchClient = webSearchOptions
      ? new OpenAI({
          apiKey,
          baseURL: webSearchOptions.baseURL ?? baseURL,
          defaultHeaders: webSearchOptions.defaultHeaders ?? options?.defaultHeaders,
        })
      : this.defaultClient;
  }

  protected webSearchParameters(requestParams: Record<string, any>): Record<string, any> {
    return requestParams;
  }

  protected getClient(options: ModelOptions): OpenAI {
    if (options.webSearch) {
      return this.webSearchClient;
    }
    return this.defaultClient;
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    return {
      supported: false,
      error: 'Web search capabilities not implemented for ' + this.constructor.name,
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const client = this.getClient(options);
    const startTime = Date.now();

    this.logRequestStart(
      options,
      model,
      maxTokens,
      systemPrompt,
      `${client.baseURL ?? 'https://api.openai.com/v1'}/chat/completions`
    );

    try {
      const messages = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ];

      this.debugLog(options, 'Request messages:', this.truncateForLogging(messages));

      let requestParams: any = {
        model,
        messages,
        ...(model.includes('o1') || model.includes('o3')
          ? {
              max_completion_tokens: maxTokens,
            }
          : {
              max_tokens: maxTokens,
            }),
      };
      if (options.webSearch) {
        requestParams = this.webSearchParameters(requestParams);
      }

      // Add reasoning_effort parameter for o1 or o3-mini models if specified
      if (this.doesModelSupportReasoningEffort(model) && options?.reasoningEffort) {
        requestParams.reasoning_effort = options.reasoningEffort;
        this.debugLog(options, `Using reasoning_effort: ${options.reasoningEffort}`);
      } else if (options?.reasoningEffort) {
        console.log(
          `Model ${model} does not support reasoning effort. Parameter will be ignored. Set OVERRIDE_SAFETY_CHECKS=true to bypass this check and pass the reasoning effort parameter to the provider API`
        );
      }
      this.debugLog(options, 'Model options:', this.truncateForLogging(options));
      // Log full request parameters in debug mode
      const url = `${client.baseURL ?? 'https://api.openai.com/v1'}/chat/completions`;
      this.debugLog(
        options,
        'Full request parameters:',
        this.truncateForLogging({ url, ...requestParams })
      );

      // Uncomment to use plain fetch
      // const responseRequest = await fetch(url, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'Authorization': `Bearer ${client.apiKey}`,
      //   },
      //   body: JSON.stringify(requestParams),
      // });
      // if(!responseRequest.ok) {
      //   const errorBody = await responseRequest.text();
      //   throw new ProviderError(`${this.constructor.name} returned an error: ${responseRequest.statusText}\n${errorBody}`);
      // }
      // const response = await responseRequest.json();

      const response = await client.chat.completions.create(requestParams);

      const endTime = Date.now();
      this.debugLog(options, `API call completed in ${endTime - startTime}ms`);
      this.debugLog(options, 'Response:', this.truncateForLogging(response));

      // Track token usage if available
      if (response.usage) {
        this.setTokenUsage(
          response.usage.prompt_tokens ?? 0,
          response.usage.completion_tokens ?? 0
        );
      }

      const content = response.choices?.[0].message.content;
      if (!content) {
        throw new ProviderError(`${this.constructor.name} returned an empty response`);
      }

      if ('citations' in response) {
        const citations = response.citations as Array<string>;
        return (
          content +
          '\n\n' +
          citations.map((citation: any, index: number) => `[${index + 1}] ${citation}`).join('\n')
        );
      }
      return content;
    } catch (error) {
      this.debugLog(options, `Error in ${this.constructor.name} executePrompt:`, error);

      // Check if this is a model not found error
      if (isModelNotFoundError(error)) {
        throw new ModelNotFoundError(
          this.provider,
          (await this.availableModels) ?? null,
          `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof BadRequestError) {
        // BadRequestError if logged unmodified will leak credentials.
        // Remove headers from error object before logging
        // @ts-ignore - headers is not always typed
        Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error';
      throw new NetworkError(
        `Failure during communication with ${this.constructor.name} API: ${message}`,
        error
      );
    }
  }
}

// Google Vertex AI provider implementation
export class GoogleVertexAIProvider extends BaseProvider {
  provider = 'gemini' as const;
  private readonly getAuthHeaders: () => Promise<{
    projectId: string;
    headers: Record<string, string>;
  }>;

  constructor() {
    super();
    this.getAuthHeaders = once(this._getAuthHeaders);
    // Initialize the promise in constructor
    this.availableModels = this.initializeModels();
    this.availableModels.catch((error) => {
      console.error('Error fetching Vertex AI models:', error);
    });
  }

  private async initializeModels(): Promise<Set<string>> {
    try {
      const { headers } = await this.getAuthHeaders();

      const response = await fetch(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models',
        {
          headers: headers,
        }
      );

      if (!response.ok) {
        console.error('Failed to fetch Vertex AI models:', await response.text());
        throw new NetworkError(`Failed to fetch Vertex AI models: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data?.publisherModels) {
        console.warn('Unexpected API response format:', data);
        return new Set();
      }
      return new Set(
        data.publisherModels.map((model: any) => {
          // Extract just the model name without the publishers/google/models/ prefix
          const name = model.name.replace('publishers/google/models/', '');
          return name;
        })
      );
    } catch (error) {
      console.error('Error fetching Vertex AI models:', error);
      throw new NetworkError('Failed to fetch available Vertex AI models', error as Error);
    }
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    try {
      const webSearchModels = Array.from((await this.availableModels) ?? []).filter(
        (m) => m.includes('gemini') && !m.includes('thinking')
      );
      if (webSearchModels.length > 0) {
        if (webSearchModels.includes(modelName)) {
          return {
            supported: true,
          };
        }
        return {
          supported: false,
          model: webSearchModels[0],
          error: `Model ${modelName} does not support web search. Try one of these models:\n${webSearchModels.map((m) => `- ${m}`).join('\n')}`,
        };
      }
      return {
        supported: true,
      };
    } catch (error) {
      console.error('Error checking web search support:', error);
      return {
        supported: false,
        error: 'Failed to check web search support. Please try again.',
      };
    }
  }

  protected webSearchParameters<T extends Record<string, any>>(requestParams: T): T {
    return {
      ...requestParams,
      tools: [
        ...(requestParams.tools ?? []).filter((tool: any) => !('google_search' in tool)),
        { google_search: {} },
      ],
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);

    // Validate model name if we have the list
    const availableModels = await this.availableModels;
    if (!availableModels) {
      throw new Error('Models not initialized. Call initializeModels() first.');
    }
    if (!availableModels.has(model)) {
      const similarModels = getSimilarModels(model, availableModels);
      throw new ModelNotFoundError(
        this.provider,
        new Set(similarModels.length > 0 ? similarModels : availableModels)
      );
    }

    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const startTime = Date.now();

    const { projectId, headers } = await this.getAuthHeaders();

    const location = 'us-central1'; // TODO: Make this configurable
    const baseURL = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

    this.logRequestStart(options, model, maxTokens, systemPrompt, baseURL);

    return retryWithBackoff(
      async () => {
        try {
          let requestBody: GoogleVertexAIRequestBody = {
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: { maxOutputTokens: maxTokens },
            ...(systemPrompt
              ? {
                  system_instruction: {
                    parts: [{ text: systemPrompt }],
                  },
                }
              : {}),
          };

          // Add web search tool only when explicitly requested
          if (options?.webSearch) {
            requestBody = this.webSearchParameters(requestBody);
          }

          this.debugLog(options, 'Request body:', this.truncateForLogging(requestBody));

          const response = await fetch(baseURL, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          const endTime = Date.now();
          this.debugLog(options, `API call completed in ${endTime - startTime}ms`);

          if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
              console.warn(
                'Received 429 error from Google API. This can occur due to token limits on free accounts. ' +
                  'For more information, see: https://github.com/eastlondoner/vibe-tools/issues/35'
              );
            }
            throw new NetworkError(`Google Vertex AI API error (${response.status}): ${errorText}`);
          }

          const data = await response.json();
          this.debugLog(options, 'Response:', this.truncateForLogging(data));

          const content = data.candidates[0]?.content?.parts[0]?.text;
          const grounding = data.candidates[0]?.groundingMetadata as GeminiGroundingMetadata;
          const webSearchQueries = grounding?.webSearchQueries;

          let webSearchText = '';
          if (webSearchQueries && webSearchQueries.length > 0) {
            webSearchText = '\nWeb search queries:\n';
            for (const query of webSearchQueries) {
              webSearchText += `- ${query}\n`;
            }
            webSearchText += '\n';
          }

          // Format response with citations if grounding metadata exists
          let formattedContent = content;
          if (grounding?.groundingSupports?.length > 0 && grounding?.groundingChunks?.length > 0) {
            const citationSources = new Map<number, { uri: string; title?: string }>();

            // Build citation sources from groundingChunks
            grounding.groundingChunks.forEach((chunk: GeminiGroundingChunk, idx: number) => {
              if (chunk.web) {
                citationSources.set(idx, {
                  uri: chunk.web.uri,
                  title: chunk.web.title,
                });
              }
            });

            // Format text with citations
            let formattedText = '';
            grounding.groundingSupports.forEach((support: GeminiGroundingSupport) => {
              const segment = support.segment;
              const citations = support.groundingChunkIndices
                .map((idx: number) => {
                  const source = citationSources.get(idx);
                  return source ? `[${idx + 1}]` : '';
                })
                .filter(Boolean)
                .join('');

              formattedText += segment.text + (citations ? ` ${citations}` : '') + ' ';
            });

            // Add citations list
            if (citationSources.size > 0) {
              let citationsText = '\nCitations:\n';
              citationSources.forEach((source, idx) => {
                citationsText += `[${idx + 1}]: ${source.uri}${source.title ? ` ${source.title}` : ''}\n`;
              });
              formattedText = citationsText + '\n' + webSearchText + formattedText;
            } else {
              formattedText = webSearchText + formattedText;
            }
            // replace the original content with the formatted text
            formattedContent = formattedText.trim();
          }

          if (!formattedContent) {
            throw new ProviderError('Google Vertex AI returned an empty response');
          }

          return formattedContent;
        } catch (error) {
          this.debugLog(options, `Error in ${this.constructor.name} executePrompt:`, error);

          // Check if this is a model not found error
          if (isModelNotFoundError(error)) {
            throw new ModelNotFoundError(
              this.provider,
              (await this.availableModels) ?? null,
              `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }

          if (error instanceof ProviderError || error instanceof NetworkError) {
            throw error;
          }
          if (error instanceof BadRequestError) {
            // strip headers from error object before logging
            // @ts-ignore - headers is not always typed
            Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
            throw error;
          }
          const message =
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error';
          throw new NetworkError(
            `Failure during communication with ${this.constructor.name} API: ${message}`,
            error
          );
        }
      },
      5,
      1000,
      (error) => {
        if (error instanceof NetworkError) {
          const errorText = error.message.toLowerCase();
          return errorText.includes('429') || errorText.includes('resource exhausted');
        }
        return false;
      }
    );
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    // Example: Google Vertex AI might have a hard limit or require specific models
    const limit = 2_000_000; // Adjust this based on actual Vertex AI limits
    console.log(`Token count: ${tokenCount}`);
    if (tokenCount >= limit) {
      return {
        error:
          `Repository content (${tokenCount} tokens) is too large for the selected model and exceeds the limit of ${limit} tokens.\n` +
          `Please reduce the context size by creating a '.repomixignore' file in your repository root and adding patterns for files/directories to exclude.\n` +
          `You can also try:\n` +
          `1. Using a more specific query to target a feature or module.\n` +
          `2. Running the command on a specific subdirectory using the --subdir flag.`,
      };
    }
    return {}; // No changes needed if within limits
  }

  private async _getAuthHeaders(): Promise<{ projectId: string; headers: Record<string, string> }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('Google Vertex AI');
    }

    // Check if the value is a path to a JSON key file
    if (apiKey.endsWith('.json')) {
      if (!existsSync(apiKey)) {
        throw new Error(`Google Vertex AI JSON key file not found at: ${apiKey}`);
      }
      console.log(`Using service account JSON key from: ${apiKey}`);

      const projectId = JSON.parse(readFileSync(apiKey, 'utf8')).project_id;
      const client = await new GoogleAuth({
        keyFile: apiKey,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        projectId: projectId,
      }).getClient();
      const token = await client.getAccessToken();
      return {
        projectId,
        headers: {
          Authorization: `Bearer ${token.token}`,
          // do not set x-goog-user-project as it will cause additional permission checks that could fail
        },
      };
    }

    // Check if the value is "adc" to use Application Default Credentials
    if (apiKey.toLowerCase() === 'adc') {
      console.log('Using Application Default Credentials for Google Vertex AI');
      try {
        let projectId: string;
        try {
          const adcPath =
            process.platform === 'win32'
              ? `${process.env.APPDATA}\\gcloud\\application_default_credentials.json`
              : `${process.env.HOME}/.config/gcloud/application_default_credentials.json`;
          projectId = JSON.parse(readFileSync(adcPath, 'utf8')).quota_project_id;
        } catch (error1) {
          console.log(
            'Unable to get project ID from Application Default Credentials file.',
            'message' in (error1 as Error) ? (error1 as Error).message : 'Unknown error',
            'Will try getting from the metadata server'
          );
          try {
            // try getting from the metadata server
            const metadataUrl =
              'http://metadata.google.internal/computeMetadata/v1/project/project-id';
            const metadataResponse = await fetch(metadataUrl, {
              headers: { 'Metadata-Flavor': 'Google' },
            });
            projectId = (await metadataResponse.text()).trim();
          } catch (error2) {
            if (error2 instanceof Error) {
              error2.cause = error1;
            }
            console.error(
              'Unable to get project ID from metadata server.',
              'message' in (error2 as Error) ? (error2 as Error).message : 'Unknown error',
              'Will try getting from gcloud config'
            );

            try {
              const gcloudResponse = await execSync('gcloud config get-value project', {
                encoding: 'utf8',
              });
              projectId = gcloudResponse.trim();
            } catch (error3) {
              console.error(
                'Unable to get project ID from gcloud config.',
                'message' in (error3 as Error) ? (error3 as Error).message : 'Unknown error'
              );
              if (error3 instanceof Error) {
                error3.cause = error2;
              }
              console.error('Unable to get project ID from any method', error3);
              throw error3;
            }
          }
        }
        const auth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          projectId,
        });

        // Test ADC by attempting to get a token
        await auth.getAccessToken();

        const client = await auth.getClient();
        if (!client.projectId) {
          console.log(`Setting project ID: ${projectId}`);
          client.projectId = projectId;
          client.quotaProjectId = projectId;
        }
        const token = await client.getAccessToken();
        return {
          projectId,
          headers: {
            Authorization: `Bearer ${token.token}`,
            ...(projectId ? { 'x-goog-user-project': projectId } : {}),
          },
        };
      } catch (error) {
        console.error('Error using Application Default Credentials (ADC):', error);
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for service disabled errors
        if (
          errorMessage.includes('SERVICE_DISABLED') ||
          errorMessage.includes('service: "aiplatform.googleapis.com"')
        ) {
          throw new Error(
            'Failed to use Application Default Credentials (ADC). The AI Platform API is not enabled.\n\n' +
              'To fix this:\n' +
              '1. Visit https://console.cloud.google.com/apis/library/aiplatform.googleapis.com\n' +
              '2. Make sure you have selected the correct project\n' +
              '3. Click "Enable" to enable the AI Platform API\n' +
              '4. Wait a few minutes for the change to propagate\n\n' +
              `Error details: ${errorMessage}`
          );
        }

        // Check for quota project related errors
        if (
          errorMessage.includes('quota project') ||
          errorMessage.includes('aiplatform.googleapis.com')
        ) {
          throw new Error(
            'Failed to use Application Default Credentials (ADC). This API requires a quota project to be set.\n\n' +
              'To fix this:\n' +
              '1. Run: gcloud auth application-default set-quota-project YOUR_PROJECT_ID\n' +
              '   Replace YOUR_PROJECT_ID with your Google Cloud project ID\n' +
              '2. Make sure the AI Platform API is enabled in this project\n' +
              '3. Ensure you have the "Service Usage Consumer" role (roles/serviceusage.serviceUsageConsumer) in the project\n' +
              '4. Verify setup by running: gcloud auth application-default print-access-token\n\n' +
              `Error details: ${errorMessage}\n\n` +
              'For more information about quota projects, visit:\n' +
              'https://cloud.google.com/docs/authentication/adc-troubleshooting/user-creds'
          );
        }

        // For other ADC errors, show the general setup instructions
        throw new Error(
          'Failed to use Application Default Credentials (ADC). Please ensure ADC is properly configured:\n\n' +
            '1. Install the Google Cloud CLI (gcloud) if not already installed\n' +
            '2. Run: gcloud auth application-default login\n' +
            '3. Run: gcloud auth application-default set-quota-project YOUR_PROJECT_ID\n' +
            '4. Enable the AI Platform API in your project by visiting:\n' +
            '   https://console.cloud.google.com/apis/library/aiplatform.googleapis.com\n' +
            '5. Verify you have the "Service Usage Consumer" role in the project\n' +
            '6. Verify you have the "Vertex AI User" role in Google Cloud Console\n' +
            '7. Test ADC setup by running: gcloud auth application-default print-access-token\n\n' +
            `Error details: ${errorMessage}\n\n` +
            'For more information, visit: https://cloud.google.com/docs/authentication/application-default-credentials'
        );
      }
    }

    throw new Error(
      'Google Vertex AI requires service account authentication. Please provide a JSON key file or use ADC.'
    );
  }
}

// Google Generative Language provider implementation
export class GoogleGenerativeLanguageProvider extends BaseProvider {
  provider = 'gemini' as const;
  constructor() {
    super();
    // Initialize the promise in constructor
    this.availableModels = this.initializeModels();
    this.availableModels.catch((error) => {
      console.error('Error fetching Google Generative Language models:', error);
    });
  }

  getDefaultMaxTokens(): number {
    return 64000;
  }

  private async initializeModels(): Promise<Set<string>> {
    try {
      const apiKey = await this.getAPIKey();
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new NetworkError(
          `Failed to fetch Gemini models: ${response.status} ${response.statusText}`,
          errorText
        );
      }

      const data = await response.json();

      if (!data?.models) {
        console.warn('Unexpected API response format:', data);
        return new Set();
      }

      const models = new Set<string>(
        data.models
          .map((model: any) => model.name.replace('models/', ''))
          .filter((name: string) => name.includes('gemini'))
      );

      return models;
    } catch (error) {
      console.error('Error fetching Gemini models:', error);
      throw new NetworkError('Failed to fetch available Gemini models', error as Error);
    }
  }

  private async getAPIKey(): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('Google Generative Language');
    }

    // If it's a JSON key or ADC, use Vertex AI instead
    if (apiKey.endsWith('.json') || apiKey.toLowerCase() === 'adc') {
      throw new Error(
        'Service account authentication is not supported for Google Generative Language API. Please use an API key.'
      );
    }

    return apiKey;
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    const unsupportedModels = new Set([
      'gemini-2.0-flash-thinking-exp-01-21',
      'gemini-2.0-flash-thinking-exp',
    ]);
    if (unsupportedModels.has(modelName)) {
      return {
        supported: false,
        model: 'gemini-2.5-pro',
        error: `Model ${modelName} does not support web search.`,
      };
    }

    return {
      supported: true,
    };
  }

  protected webSearchParameters(
    requestParams: GoogleGenerativeLanguageRequestBody
  ): GoogleGenerativeLanguageRequestBody {
    return {
      ...requestParams,
      tools: [
        ...(requestParams.tools ?? []).filter((tool: any) => !('google_search' in tool)),
        { google_search: {} },
      ],
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const startTime = Date.now();

    const baseURL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    this.logRequestStart(options, model, maxTokens, systemPrompt, baseURL);

    return retryWithBackoff(
      async () => {
        try {
          let requestBody: GoogleGenerativeLanguageRequestBody = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens },
            ...(systemPrompt
              ? {
                  system_instruction: {
                    parts: [{ text: systemPrompt }],
                  },
                }
              : {}),
          };

          // Add web search tool only when explicitly requested
          if (options?.webSearch) {
            requestBody = this.webSearchParameters(requestBody);
          }

          this.debugLog(options, 'Request body:', this.truncateForLogging(requestBody));

          const apiKey = await this.getAPIKey();
          const url = `${baseURL}?key=${apiKey}`;

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          const endTime = Date.now();
          this.debugLog(options, `API call completed in ${endTime - startTime}ms`);

          if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
              if (options.debug) {
                console.log('Response:', errorText, response);
              }
              console.warn(
                'Received 429 error from Google API. This can occur due to token limits on free accounts. ' +
                  'For more information, see: https://github.com/eastlondoner/vibe-tools/issues/35'
              );
            }
            throw new NetworkError(
              `Google Generative Language API error (${response.status}): ${errorText}`
            );
          }

          const data = await response.json();
          this.debugLog(options, 'Response:', this.truncateForLogging(data));

          // Track token usage if available
          if (data.usage) {
            this.setTokenUsage(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
          }

          // Sometimes gemini returns something that doesn't have a candidates array
          if (!data.candidates) {
            console.error(
              'Google Generative Language returned an unexpected response:',
              JSON.stringify(data, null, 2)
            );
            throw new ProviderError('Google Generative Language returned an unexpected response');
          }
          const content = data.candidates[0]?.content?.parts?.[0]?.text;
          if (!content) {
            console.log(
              'Google Generative Language returned an empty response. This often happens when it spends all its output tokens on thinking. Increase the maxTokens parameter to get more output.'
            );
          }
          const grounding = data.candidates[0]?.groundingMetadata as GeminiGroundingMetadata;
          const webSearchQueries = grounding?.webSearchQueries;

          // Debug: Log the raw model response content
          if (options.debug) {
            console.log('\n===== RAW MODEL RESPONSE START =====');
            console.log(content);
            console.log('===== RAW MODEL RESPONSE END =====\n');
          }

          let webSearchText = '';
          if (webSearchQueries && webSearchQueries.length > 0) {
            webSearchText = '\nWeb search queries:\n';
            for (const query of webSearchQueries) {
              webSearchText += `- ${query}\n`;
            }
            webSearchText += '\n';
          }

          // Format response with citations if grounding metadata exists
          let formattedContent = content;
          if (grounding?.groundingSupports?.length > 0 && grounding?.groundingChunks?.length > 0) {
            const citationSources = new Map<number, { uri: string; title?: string }>();

            // Build citation sources from groundingChunks
            grounding.groundingChunks.forEach((chunk: GeminiGroundingChunk, idx: number) => {
              if (chunk.web) {
                citationSources.set(idx, {
                  uri: chunk.web.uri,
                  title: chunk.web.title,
                });
              }
            });

            // SIMPLIFIED: Preserve original content and just append citations
            // This ensures we don't lose or truncate any content
            let formattedText = content || '';

            // Add citations at the end
            if (citationSources.size > 0) {
              let citationsText = '\n\nCitations:\n';
              citationSources.forEach((source, idx) => {
                citationsText += `[${idx + 1}]: ${source.uri}${source.title ? ` ${source.title}` : ''}\n`;
              });
              formattedText = formattedText + '\n\n' + webSearchText + citationsText;
            } else {
              formattedText = formattedText + '\n\n' + webSearchText;
            }
            // replace the original content with the formatted text
            formattedContent = formattedText.trim();

            // Debug: Log the formatted response for comparison
            if (options.debug) {
              console.log('\n===== FORMATTED RESPONSE START =====');
              console.log(formattedContent);
              console.log('===== FORMATTED RESPONSE END =====\n');
            }
          }

          // Track token usage from usageMetadata if available
          if (data.usageMetadata) {
            this.setTokenUsage(
              data.usageMetadata.promptTokenCount ?? 0,
              data.usageMetadata.candidatesTokenCount ?? 0 // Note: This might include multiple candidates
            );
          }

          if (!formattedContent) {
            throw new ProviderError('Google Generative Language returned an empty response');
          }

          return formattedContent;
        } catch (error) {
          this.debugLog(options, `Error in ${this.constructor.name} executePrompt:`, error);

          // Check if this is a model not found error
          if (isModelNotFoundError(error)) {
            throw new ModelNotFoundError(
              this.provider,
              (await this.availableModels) ?? null,
              `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }

          if (error instanceof ProviderError || error instanceof NetworkError) {
            throw error;
          }
          if (error instanceof BadRequestError) {
            // strip headers from error object before logging
            // @ts-ignore - headers is not always typed
            Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
            throw error;
          }
          const message =
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error';
          throw new NetworkError(
            `Failure during communication with ${this.constructor.name} API: ${message}`,
            error
          );
        }
      },
      5,
      1000,
      (error) => {
        if (error instanceof NetworkError) {
          const errorText = error.message?.toLowerCase();
          return (
            errorText?.includes('429') ||
            errorText?.includes('resource exhausted') ||
            errorText?.includes('rate limit') ||
            errorText?.includes('try again later')
          );
        }
        return false;
      }
    );
  }

  // Add executeVideoPrompt method
  async executeVideoPrompt(prompt: string, options: VideoAnalysisOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const videoUrl = options.videoUrl;

    if (!videoUrl) {
      throw new Error('Video URL is required for video analysis');
    }

    const startTime = Date.now();

    this.logRequestStart(
      options,
      model,
      maxTokens,
      systemPrompt,
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'
    );

    return retryWithBackoff(
      async () => {
        try {
          // Set default generationConfig
          const generationConfig = {
            maxOutputTokens: maxTokens,
            temperature: 1,
            topK: 40,
            topP: 0.95,
            responseMimeType: 'text/plain',
          };

          // Use custom generationConfig from options if provided
          if (options.temperature !== undefined) {
            generationConfig.temperature = options.temperature;
          }
          if (options.topK !== undefined) {
            generationConfig.topK = options.topK;
          }
          if (options.topP !== undefined) {
            generationConfig.topP = options.topP;
          }

          const requestBody = {
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: videoUrl,
                      mimeType: 'video/*',
                    },
                  },
                  {
                    text: prompt,
                  },
                ],
              },
            ],
            generationConfig,
            ...(systemPrompt
              ? {
                  systemInstruction: {
                    role: 'user',
                    parts: [{ text: systemPrompt }],
                  },
                }
              : {}),
          };

          this.debugLog(options, 'Request body:', this.truncateForLogging(requestBody));

          const apiKey = await this.getAPIKey();
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          const endTime = Date.now();
          this.debugLog(options, `API call completed in ${endTime - startTime}ms`);

          if (!response.ok) {
            const errorText = await response.text();
            const status = response.status;

            // Handle specific error codes
            if (status === 400) {
              if (errorText.includes('fileData.fileUri is not a valid YouTube video URL')) {
                throw new NetworkError(
                  `Invalid YouTube URL: ${videoUrl}. Please provide a valid URL.`
                );
              } else if (errorText.includes('video is too long')) {
                throw new NetworkError('The video is too long for analysis. Try a shorter video.');
              } else {
                throw new NetworkError(`Bad Request (400): ${errorText}`);
              }
            } else if (status === 403) {
              throw new NetworkError(
                'Access denied (403). The video might be private or age-restricted.'
              );
            } else if (status === 404) {
              throw new NetworkError(
                'Video not found (404). The URL might be incorrect or the video was removed.'
              );
            } else if (status === 429) {
              throw new NetworkError('Rate limit or quota exceeded (429). Please try again later.');
            } else if (status >= 500) {
              throw new NetworkError(
                `Server error (${status}): ${errorText}. Please try again later.`
              );
            } else {
              throw new NetworkError(
                `Google Generative Language API error (${status}): ${errorText}`
              );
            }
          }

          const data = await response.json();
          this.debugLog(options, 'Response:', this.truncateForLogging(data));

          // Handle response similar to executePrompt
          if (!data.candidates) {
            console.error(
              'Google Generative Language returned an unexpected response:',
              JSON.stringify(data, null, 2)
            );
            throw new ProviderError('Google Generative Language returned an unexpected response');
          }

          const content = data.candidates[0]?.content?.parts[0]?.text || '';
          return content;
        } catch (error) {
          if (error instanceof NetworkError) {
            throw error;
          }

          throw new NetworkError(
            'Failed to execute video prompt with Google Generative Language API',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      5, // maxRetries
      1000, // initialDelay
      (error) => {
        // Only retry on server errors (5xx) or temporary network issues
        if (error instanceof NetworkError) {
          const errorText = error.message?.toLowerCase();
          return (
            errorText?.includes('429') ||
            errorText?.includes('resource exhausted') ||
            errorText?.includes('rate limit') ||
            errorText?.includes('try again later')
          );
        }
        return false; // Don't retry on other errors
      }
    );
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    // Example: Gemini API limit might be 2M tokens
    const limit = 2_000_000;
    if (tokenCount >= limit) {
      return {
        error:
          `Repository content (${tokenCount} tokens) is too large for the Gemini API and exceeds the limit of ${limit} tokens.\n` +
          `Please reduce the context size by creating a '.repomixignore' file in your repository root and adding patterns for files/directories to exclude.\n` +
          `You can also try:\n` +
          `1. Using a more specific query to target a feature or module.\n` +
          `2. Running the command on a specific subdirectory using the --subdir flag.`,
      };
    }
    // Suggest larger model if available and appropriate (example logic)
    // if (tokenCount > 1_000_000) { // Example threshold
    //   return { model: 'gemini-2.5-pro' }; // Suggest a larger model if needed
    // }
    return {}; // No changes needed if within limits
  }
}

// OpenAI provider implementation
export class OpenAIProvider extends OpenAIBase {
  provider = 'openai' as const;
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('OpenAI');
    }
    super(apiKey);
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    return {
      supported: false,
      error: 'OpenAI does not support web search capabilities',
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const messageLimit = 1048576; // OpenAI's character limit
    const client = this.getClient(options);
    const promptChunks = chunkMessage(prompt, messageLimit);
    let combinedResponseContent = '';

    for (const chunk of promptChunks) {
      try {
        const messages = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          { role: 'user' as const, content: chunk },
        ];

        this.debugLog(options, 'Request messages:', this.truncateForLogging(messages));

        // Create request parameters, including model-specific configurations
        const requestParams: any = {
          model,
          messages,
          ...(model.startsWith('o') || model.startsWith('gpt-4.1') || model.startsWith('gpt-5')
            ? {
                max_completion_tokens: maxTokens,
              }
            : {
                max_tokens: maxTokens,
              }),
        };

        // Add reasoning_effort parameter for o1 or o3-mini models if specified
        if (this.doesModelSupportReasoningEffort(model) && options?.reasoningEffort) {
          requestParams.reasoning_effort = options.reasoningEffort;
          this.debugLog(options, `Using reasoning_effort: ${options.reasoningEffort}`);
        } else if (options?.reasoningEffort) {
          this.debugLog(
            options,
            `Model ${model} does not support reasoning effort. Parameter will be ignored. Set OVERRIDE_SAFETY_CHECKS=true to bypass this check and pass the reasoning effort parameter to the provider API`
          );
        }

        // Log full request parameters in debug mode
        this.debugLog(options, 'Full request parameters:', this.truncateForLogging(requestParams));

        const response = await client.chat.completions.create(requestParams);

        this.debugLog(options, 'Response:', JSON.stringify(response, null, 2));

        const content = response.choices?.[0]?.message?.content;
        if (content) {
          combinedResponseContent += content + '\n'; // Append chunk response
        } else {
          console.warn(`${this.constructor.name} returned an empty response chunk.`);
        }
      } catch (error) {
        this.debugLog(options, `Error in ${this.constructor.name} executePrompt chunk`, error);

        // Check if this is a model not found error
        if (isModelNotFoundError(error)) {
          throw new ModelNotFoundError(
            this.provider,
            (await this.availableModels) ?? null,
            `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
        if (error instanceof ProviderError || error instanceof NetworkError) {
          throw error;
        }
        if (error instanceof BadRequestError) {
          // strip headers from error object before logging
          // @ts-ignore - headers is not always typed
          Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
          throw error;
        }
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'Unknown error';
        throw new NetworkError(
          `Failure during communication with ${this.constructor.name} API: ${message}`,
          error
        );
      }
    }

    if (!combinedResponseContent.trim()) {
      throw new ProviderError(
        `${this.constructor.name} returned an overall empty response after processing chunks.`
      );
    }
    return combinedResponseContent.trim();
  }
}

// OpenRouter provider implementation
export class OpenRouterProvider extends OpenAIBase {
  provider = 'openrouter' as const;
  private readonly headers: Record<string, string>;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('OpenRouter');
    }
    const headers = {
      'HTTP-Referer': 'http://vibe-tools.com',
      'X-Title': 'vibe-tools',
    };
    super(apiKey, 'https://openrouter.ai/api/v1', {
      defaultHeaders: headers,
    });
    this.headers = headers;
    // Initialize the promise in constructor
    this.availableModels = this.initializeModels();
    this.availableModels.catch((error) => {
      console.error('Error fetching OpenRouter models:', error);
    });
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    // OpenRouter routes to various models, limits depend on the underlying model.
    // This is a generic message, assuming a high limit might be exceeded.
    const limit = 2_000_000; // Assuming a potential high limit across models
    if (tokenCount >= limit) {
      return {
        error:
          `Repository content (${tokenCount} tokens) may be too large for the selected OpenRouter model (limit depends on underlying model, potentially ~${limit} tokens).\n` +
          `Please reduce the context size by creating a '.repomixignore' file in your repository root and adding patterns for files/directories to exclude.\n` +
          `You can also try:\n` +
          `1. Selecting a model known to support larger contexts via the --model flag.\n` +
          `2. Using a more specific query or the --subdir flag.`,
      };
    }
    return {};
  }

  private async initializeModels(): Promise<Set<string>> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          ...this.headers,
        },
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch OpenRouter models: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data?.data) {
        console.warn('Unexpected API response format:', data);
        return new Set();
      }
      // Each model in the response has an 'id' field that we can use
      return new Set(data.data.map((model: any) => model.id));
    } catch (error) {
      console.error('Error fetching OpenRouter models:', error);
      throw new NetworkError('Failed to fetch available OpenRouter models', error);
    }
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const client = this.getClient(options);

    try {
      const messages = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ];

      this.logRequestStart(
        options,
        model,
        maxTokens,
        systemPrompt,
        `${client.baseURL ?? 'https://openrouter.ai/api/v1'}/chat/completions`,
        this.headers
      );

      // Create request parameters
      const requestParams: any = {
        model,
        messages,
        max_tokens: maxTokens,
      };

      // Add reasoning_effort parameter for o1 or o3-mini models if specified
      if (this.doesModelSupportReasoningEffort(model) && options?.reasoningEffort) {
        // OpenRouter has a different format for reasoning parameters
        // https://openrouter.ai/docs/use-cases/reasoning-tokens
        requestParams.reasoning = {
          effort: options.reasoningEffort,
        };
        this.debugLog(options, `Using reasoning effort: ${options.reasoningEffort}`);
      } else if (options?.reasoningEffort) {
        console.log(
          `Model ${model} does not support reasoning effort. Parameter will be ignored. Set OVERRIDE_SAFETY_CHECKS=true to bypass this check and pass the reasoning effort parameter to the provider API`
        );
      }

      const response = await client.chat.completions.create(requestParams, {
        timeout: Math.floor(options?.timeout ?? TEN_MINUTES),
        maxRetries: 3,
      });

      this.debugLog(options, 'Response:', JSON.stringify(response, null, 2));

      const content = response.choices[0].message.content;
      if (!content) {
        throw new ProviderError(`${this.constructor.name} returned an empty response`);
      }
      return content;
    } catch (error) {
      this.debugLog(options, 'OpenRouter Provider: Error during API call:', error);

      // Check if this is a model not found error
      if (isModelNotFoundError(error)) {
        throw new ModelNotFoundError(
          this.provider,
          (await this.availableModels) ?? null,
          `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      if (error instanceof ProviderError || error instanceof NetworkError) {
        throw error;
      }
      if (error instanceof BadRequestError) {
        // strip headers from error object before logging
        // @ts-ignore - headers is not always typed
        Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error';
      throw new NetworkError(
        `Failure during communication with ${this.constructor.name} API: ${message}`,
        error
      );
    }
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    if (modelName.startsWith('perplexity')) {
      return { supported: true };
    }
    return {
      supported: false,
      model: 'perplexity/sonar-reasoning-pro',
      error: 'OpenRouter does not support web search capabilities',
    };
  }
}

// Perplexity provider implementation
export class PerplexityProvider extends BaseProvider {
  provider = 'perplexity' as const;

  protected webSearchParameters(requestParams: Record<string, any>): Record<string, any> {
    return requestParams;
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    if (modelName.startsWith('sonar')) {
      return { supported: true };
    }
    return {
      supported: false,
      model: 'sonar-pro',
      error: `Model ${modelName} does not support web search. Use a model with -online suffix instead.`,
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('Perplexity');
    }

    return retryWithBackoff(
      async () => {
        const model = await this.getModel(options);
        const maxTokens = options.maxTokens;
        const systemPrompt = this.getSystemPrompt(options);
        const startTime = Date.now();

        this.logRequestStart(
          options,
          model,
          maxTokens,
          systemPrompt,
          'https://api.perplexity.ai/chat/completions'
        );

        try {
          const requestBody = {
            model,
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              { role: 'user', content: prompt },
            ],
            max_tokens: maxTokens,
          };

          this.debugLog(options, 'Request body:', this.truncateForLogging(requestBody));

          const response = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          const endTime = Date.now();
          this.debugLog(options, `API call completed in ${endTime - startTime}ms`);

          if (!response.ok) {
            const errorText = await response.text();
            throw new NetworkError(`Perplexity API error: ${errorText}`);
          }

          const data = await response.json();
          this.debugLog(options, 'Response:', this.truncateForLogging(data));

          // Track token usage if available
          if (data.usage) {
            this.setTokenUsage(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
          }

          const content = data.choices[0]?.message?.content;

          if (!content) {
            throw new ProviderError('Perplexity returned an empty response');
          }

          return content;
        } catch (error) {
          this.debugLog(options, 'Perplexity Provider: Error during API call:', error);

          // Check if this is a model not found error
          if (isModelNotFoundError(error)) {
            throw new ModelNotFoundError(
              this.provider,
              (await this.availableModels) ?? null,
              `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }

          if (error instanceof ProviderError || error instanceof NetworkError) {
            throw error;
          }
          if (error instanceof BadRequestError) {
            // strip headers from error object before logging
            // @ts-ignore - headers is not always typed
            Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
            throw error;
          }
          const message =
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error';
          throw new NetworkError(
            `Failure during communication with ${this.constructor.name} API: ${message}`,
            error
          );
        }
      },
      5,
      1000,
      (error) => {
        if (error instanceof NetworkError) {
          const errorText = error.message.toLowerCase();
          return errorText.includes('429') || errorText.includes('rate limit');
        }
        return false;
      }
    );
  }
}

// ModelBox provider implementation
export class ModelBoxProvider extends OpenAIBase {
  provider = 'modelbox' as const;
  private static readonly defaultHeaders: Record<string, string> = {};
  private static readonly webSearchHeaders: Record<string, string> = {
    'x-feature-search-internet': 'true',
  };

  constructor() {
    const apiKey = process.env.MODELBOX_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('ModelBox');
    }
    super(
      apiKey,
      'https://api.model.box/v1',
      {
        defaultHeaders: ModelBoxProvider.defaultHeaders,
      },
      {
        defaultHeaders: ModelBoxProvider.webSearchHeaders,
      }
    );
    // Initialize the promise in constructor
    this.availableModels = this.initializeModels();
    this.availableModels.catch((error) => {
      console.error('Error fetching ModelBox models:', error);
    });
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    // ModelBox routes to various models, limits depend on the underlying model.
    // Generic message similar to OpenRouter.
    const limit = 2_000_000; // Assuming a potential high limit
    if (tokenCount >= limit) {
      return {
        error:
          `Repository content (${tokenCount} tokens) may be too large for the selected ModelBox model (limit depends on underlying model, potentially ~${limit} tokens).\n` +
          `Please reduce the context size by creating a '.repomixignore' file in your repository root and adding patterns for files/directories to exclude.\n` +
          `You can also try:\n` +
          `1. Selecting a model known to support larger contexts via the --model flag.\n` +
          `2. Using a more specific query or the --subdir flag.`,
      };
    }
    return {};
  }

  private async initializeModels(): Promise<Set<string>> {
    try {
      const response = await fetch('https://api.model.box/v1/models', {
        headers: {
          Authorization: `Bearer ${process.env.MODELBOX_API_KEY}`,
        },
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch ModelBox models: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data?.data) {
        console.warn('Unexpected API response format:', data);
        return new Set();
      }
      // Keep the full model ID including provider prefix
      return new Set(data.data.map((model: any) => model.id));
    } catch (error) {
      console.error('Error fetching ModelBox models:', error);
      throw new NetworkError('Failed to fetch available ModelBox models', error);
    }
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    try {
      const availableModels = await this.availableModels;
      if (!availableModels) {
        throw new Error('Models not initialized. Call initializeModels() first.');
      }

      // Try to find the model with or without prefix
      const modelWithoutPrefix = modelName.includes('/') ? modelName.split('/')[1] : modelName;
      const matchingModels = Array.from(availableModels).filter(
        (m) =>
          m === modelName || // Exact match with prefix
          m === `openai/${modelName}` || // Try with openai prefix
          m.endsWith(`/${modelWithoutPrefix}`) || // Match with any prefix
          m === modelWithoutPrefix // Exact match without prefix
      );

      if (matchingModels.length === 0) {
        // Find similar models by comparing against both prefixed and unprefixed versions
        const similarModels = Array.from(availableModels)
          .filter((m) => {
            const mWithoutPrefix = m.includes('/') ? m.split('/')[1] : m;
            return stringSimilarity(modelWithoutPrefix, mWithoutPrefix) > 0.5;
          })
          .sort((a, b) => {
            const aWithoutPrefix = a.includes('/') ? a.split('/')[1] : a;
            const bWithoutPrefix = b.includes('/') ? b.split('/')[1] : b;
            return (
              stringSimilarity(modelWithoutPrefix, bWithoutPrefix) -
              stringSimilarity(modelWithoutPrefix, aWithoutPrefix)
            );
          });

        const webSearchModels = similarModels.filter(
          (m) => m.includes('sonar') || m.includes('online') || m.includes('gemini')
        );

        if (webSearchModels.length > 0) {
          return {
            supported: false,
            model: webSearchModels[0],
            error: `Model '${modelName}' not found. Consider using ${webSearchModels[0]} for web search instead.\nNote: ModelBox requires provider prefixes (e.g., 'openai/gpt-4.1' instead of just 'gpt-4.1').`,
          };
        }

        return {
          supported: false,
          error: `Model '${modelName}' not found.\n\nAvailable web search models:\n${Array.from(
            availableModels
          )
            .filter((m) => m.includes('sonar') || m.includes('online') || m.includes('gemini'))
            .slice(0, 5)
            .map((m) => `- ${m}`)
            .join(
              '\n'
            )}\n\nNote: ModelBox requires provider prefixes (e.g., 'openai/gpt-4.1' instead of just 'gpt-4.1').`,
        };
      }

      // Use the first matching model (prioritizing exact matches)
      const resolvedModel = matchingModels[0];

      // Check if the model supports web search
      if (isWebSearchSupportedModelOnModelBox(resolvedModel)) {
        return { supported: true };
      }

      // Suggest a web search capable model
      const webSearchModels = Array.from(availableModels)
        .filter((m) => m.includes('sonar') || m.includes('online') || m.includes('gemini'))
        .slice(0, 5);

      return {
        supported: false,
        model: webSearchModels[0],
        error: `Model ${resolvedModel} does not support web search. Try one of these models:\n${webSearchModels.map((m) => `- ${m}`).join('\n')}`,
      };
    } catch (error) {
      console.error('Error checking web search support:', error);
      return {
        supported: false,
        error: 'Failed to check web search support. Please try again.',
      };
    }
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const client = this.getClient(options);

    try {
      const messages = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ];

      this.logRequestStart(
        options,
        model,
        maxTokens,
        systemPrompt,
        `${client.baseURL ?? 'https://api.model.box/v1'}/chat/completions`,
        options.webSearch ? ModelBoxProvider.webSearchHeaders : ModelBoxProvider.defaultHeaders
      );

      const response = await client.chat.completions.create(
        {
          model,
          messages,
          max_tokens: maxTokens,
        },
        {
          timeout: Math.floor(options?.timeout ?? TEN_MINUTES),
          maxRetries: 3,
        }
      );

      this.debugLog(options, 'Response:', JSON.stringify(response, null, 2));

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new ProviderError(`${this.constructor.name} returned an empty response`);
      }
      return content;
    } catch (error) {
      this.debugLog(options, 'ModelBox Provider: Error during API call:', error);

      // Check if this is a model not found error
      if (isModelNotFoundError(error)) {
        throw new ModelNotFoundError(this.provider, (await this.availableModels) ?? null);
      }

      if (error instanceof ProviderError || error instanceof NetworkError) {
        throw error;
      }
      if (error instanceof BadRequestError) {
        // strip headers from error object before logging
        // @ts-ignore - headers is not always typed
        Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error';
      throw new NetworkError(
        `Failure during communication with ${this.constructor.name} API: ${message}`,
        error
      );
    }
  }
}

// Anthropic provider implementation
export class AnthropicProvider extends BaseProvider {
  provider = 'anthropic' as const;
  private client: Anthropic;

  protected webSearchParameters(requestParams: Record<string, any>): Record<string, any> {
    return requestParams;
  }

  constructor() {
    super();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('Anthropic');
    }
    this.client = new Anthropic({
      apiKey,
    });
  }

  protected handleLargeTokenCount(tokenCount: number): { model?: string; error?: string } {
    // Example: Claude models might have limits like 200k or higher
    const limit = 200_000; // Adjust based on typical Claude limits
    if (tokenCount >= limit) {
      return {
        error:
          `Repository content (${tokenCount} tokens) may be too large for the selected Anthropic model (limit often ~${limit} tokens, but varies by model).\n` +
          `Please reduce the context size by creating a '.repomixignore' file in your repository root and adding patterns for files/directories to exclude.\n` +
          `You can also try:\n` +
          `1. Selecting a model known to support larger contexts (like Claude 3 models) via the --model flag.\n` +
          `2. Using a more specific query or the --subdir flag.`,
      };
    }
    return {};
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    return {
      supported: false,
      error: 'Anthropic does not support web search capabilities',
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    const model = await this.getModel(options);
    const maxTokens = options.maxTokens;
    const systemPrompt = this.getSystemPrompt(options);
    const startTime = Date.now();

    this.logRequestStart(
      options,
      model,
      maxTokens,
      systemPrompt,
      'https://api.anthropic.com/v1/messages'
    );

    try {
      // Debug logging for reasoning effort support
      const supportsReasoningEffort = this.doesModelSupportReasoningEffort(model);
      if (options?.debug) {
        console.log(`Model ${model} supports reasoning effort: ${supportsReasoningEffort}`);
        console.log(`Reasoning effort option: ${options?.reasoningEffort || 'not set'}`);
      }

      // Create base message parameters according to Anthropic SDK requirements
      const requestParams = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user' as const, content: prompt }],
      };

      // Add extended thinking if supported by the model and reasoningEffort is set
      if (this.doesModelSupportReasoningEffort(model) && options?.reasoningEffort) {
        // Map reasoning effort levels to token budgets
        let budgetTokens: number;
        switch (options.reasoningEffort) {
          case 'low':
            budgetTokens = 4000;
            break;
          case 'medium':
            budgetTokens = 8000;
            break;
          case 'high':
            budgetTokens = 16000;
            break;
          default:
            console.log(
              `Unrecognized reasoning effort value ${options.reasoningEffort}, using default reasoning effort (medium).`
            );
            budgetTokens = 8000; // Default to medium if somehow invalid
        }

        // Ensure budget tokens is less than max tokens
        if (budgetTokens > maxTokens) {
          budgetTokens = Math.floor(maxTokens * 0.7); // Use 70% of max tokens if budget exceeds max
        }

        if (options?.debug) {
          console.log(`Using extended thinking with budget: ${budgetTokens} tokens`);
        }

        // Create the final params with thinking included
        const requestParamsWithThinking = {
          ...requestParams,
          thinking: {
            type: 'enabled' as const,
            budget_tokens: budgetTokens,
          },
        };

        // Show full request body for debugging
        if (options?.debug) {
          console.log('Full request body:', JSON.stringify(requestParamsWithThinking, null, 2));
        }

        const response = await this.client.messages.create(requestParamsWithThinking);

        const endTime = Date.now();
        this.debugLog(options, `API call completed in ${endTime - startTime}ms`);
        this.debugLog(options, 'Response:', this.truncateForLogging(response));

        // Track token usage (Anthropic specific)
        if (response.usage) {
          this.setTokenUsage(response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0);
        }

        // Handle response with thinking content blocks
        let content;
        if (response.content && Array.isArray(response.content)) {
          // Log the thinking blocks if available and debug is enabled
          if (options?.debug) {
            const thinkingBlocks = response.content.filter(
              (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
            );
            if (thinkingBlocks.length > 0) {
              console.log(`Found ${thinkingBlocks.length} thinking blocks in response`);
              if (thinkingBlocks[0].type === 'thinking') {
                console.log(
                  'First thinking block:',
                  thinkingBlocks[0].thinking?.substring(0, 200) + '...'
                );
              } else {
                console.log('Redacted thinking block present');
              }
            }
          }

          // Filter for text blocks only (ignoring thinking blocks)
          const textBlocks = response.content.filter((block) => block.type === 'text');
          if (textBlocks.length > 0 && textBlocks[0].type === 'text') {
            content = textBlocks[0].text;
          } else {
            console.error('Anthropic returned no text blocks:', response);
            throw new ProviderError('Anthropic returned no text blocks');
          }
        } else {
          console.error('Anthropic returned an invalid response:', response);
          throw new ProviderError('Anthropic returned an invalid response');
        }

        return content;
      } else {
        // No thinking requested or model doesn't support it
        if (options?.reasoningEffort) {
          console.log(
            `Model ${model} does not support extended thinking. Parameter will be ignored. Set OVERRIDE_SAFETY_CHECKS=true to bypass this check and pass the reasoning effort parameter to the provider API`
          );
        }

        // Show full request body for debugging
        if (options?.debug) {
          console.log('Full request body:', JSON.stringify(requestParams, null, 2));
        }

        const response = await this.client.messages.create(requestParams);

        const endTime = Date.now();
        this.debugLog(options, `API call completed in ${endTime - startTime}ms`);
        this.debugLog(options, 'Response:', this.truncateForLogging(response));

        // Track token usage (Anthropic specific)
        if (response.usage) {
          this.setTokenUsage(response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0);
        }

        // Handle regular response without thinking
        const content = response.content?.[0];
        if (!content || content.type !== 'text') {
          console.error('Anthropic returned an invalid response:', response);
          throw new ProviderError('Anthropic returned an invalid response');
        }

        return content.text;
      }
    } catch (error) {
      this.debugLog(options, 'Error executing Anthropic prompt:', error);

      // Check if this is a model not found error
      if (isModelNotFoundError(error)) {
        throw new ModelNotFoundError(
          this.provider,
          (await this.availableModels) ?? null,
          `You requested: ${model}\n\nError details: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      if (error instanceof ProviderError || error instanceof NetworkError) {
        throw error;
      }
      if (error instanceof BadRequestError) {
        // strip headers from error object before logging
        // @ts-ignore - headers is not always typed
        Object.keys(error.headers || {}).forEach((key) => delete error.headers[key]);
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error';
      throw new NetworkError(
        `Failure during communication with ${this.constructor.name} API: ${message}`,
        error
      );
    }
  }
}

// X.AI (Grok) provider implementation
export class XAIProvider extends OpenAIBase {
  provider = 'xai' as const;
  constructor() {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('X.AI');
    }
    super(apiKey, 'https://api.x.ai/v1');

    // X.AI doesn't have a public model list API yet, so hardcode known models.
    this.availableModels = Promise.resolve(new Set(['grok-4-latest', 'grok-3-mini-latest']));
  }

  protected webSearchParameters(requestParams: Record<string, any>): Record<string, any> {
    return {
      ...requestParams,
      search_parameters: { mode: 'on', return_citations: true },
    };
  }

  protected doesModelSupportReasoningEffort(model: string): boolean {
    return model.includes('grok-3');
  }

  // X.AI API is OpenAI compatible and supports web search via its own parameter
  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    return {
      supported: true,
    };
  }
}

// Groq provider implementation
export class GroqProvider extends OpenAIBase {
  provider = 'groq' as const;
  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new ApiKeyMissingError('Groq');
    }

    super(apiKey, 'https://api.groq.com/openai/v1');

    // Initialize the promise in constructor
    this.availableModels = this.initializeModels();
    this.availableModels.catch((error) => {
      console.error('Error fetching Groq models:', error);
    });
  }

  private async initializeModels(): Promise<Set<string>> {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch Groq models: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data?.data) {
        console.warn('Unexpected API response format:', data);
        return new Set();
      }

      // Each model in the response has an 'id' field that we can use
      return new Set(data.data.map((model: any) => model.id));
    } catch (error) {
      console.error('Error fetching Groq models:', error);
      throw new NetworkError('Failed to fetch available Groq models', error);
    }
  }

  async supportsWebSearch(
    modelName: string
  ): Promise<{ supported: boolean; model?: string; error?: string }> {
    return {
      supported: false,
      error: 'Groq does not support web search capabilities',
    };
  }

  async executePrompt(prompt: string, options: ModelOptions): Promise<string> {
    // Apply Groq-specific default for maxTokens if not explicitly set
    // This ensures Groq uses 16000 tokens by default when user hasn't specified
    const groqOptions: ModelOptions = {
      ...options,
      maxTokens: options.maxTokens ?? 16000,
    };

    // Debug logging when default is applied
    if (options.maxTokens === undefined || options.maxTokens === null) {
      this.debugLog(groqOptions, 'No maxTokens specified, using Groq default: 16000');
    }

    // Call parent implementation with modified options
    return super.executePrompt(prompt, groqOptions);
  }

  getDefaultMaxTokens(): number {
    return 16000;
  }
}

// Factory function to create providers
export function createProvider(
  provider:
    | 'gemini'
    | 'openai'
    | 'openrouter'
    | 'perplexity'
    | 'modelbox'
    | 'anthropic'
    | 'xai'
    | 'groq'
): BaseModelProvider {
  switch (provider) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new ApiKeyMissingError('Gemini');
      }

      // Choose between Vertex AI and Generative Language based on credentials
      if (apiKey.endsWith('.json') || apiKey.toLowerCase() === 'adc') {
        const vertexProvider = new GoogleVertexAIProvider();
        return vertexProvider;
      } else {
        return new GoogleGenerativeLanguageProvider();
      }
    }
    case 'openai':
      return new OpenAIProvider();
    case 'openrouter':
      return new OpenRouterProvider();
    case 'perplexity':
      return new PerplexityProvider();
    case 'modelbox': {
      const provider = new ModelBoxProvider();

      return provider;
    }
    case 'anthropic':
      return new AnthropicProvider();
    case 'xai':
      return new XAIProvider();
    case 'groq':
      return new GroqProvider();
    default:
      throw exhaustiveMatchGuard(
        provider,
        `Provider "${provider}" is not recognized. Valid provider values are ${getAllProviders()
          .filter((p) => p.available)
          .map((p) => p.provider)
          .join(', ')}`
      );
  }
}

function isWebSearchSupportedModelOnModelBox(model: string): boolean {
  // Extract model name without provider prefix if present
  const modelWithoutPrefix = model.includes('/') ? model.split('/')[1] : model;
  return (
    modelWithoutPrefix.includes('sonar') ||
    modelWithoutPrefix.includes('online') ||
    modelWithoutPrefix.includes('gemini')
  );
}
