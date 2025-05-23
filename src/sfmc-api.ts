import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import https from 'https';

// Export the interface so it can be imported in index.ts
export interface SFMCConfig {
    clientId: string;
    clientSecret: string;
    authBaseUri: string;
    restBaseUri: string;
    accountId?: string;
    proxy?: string;
    // Optional: SSL configuration options
    rejectUnauthorized?: boolean;
    certPath?: string;
}

export class SFMCAPIService {
    private config: SFMCConfig;
    private axiosInstance: AxiosInstance;
    private accessToken: string | null = null;
    private tokenExpiration: Date | null = null;

    constructor(config: SFMCConfig) {
        this.config = config;

        // Create axios instance with simpler configuration
        this.axiosInstance = axios.create({
            headers: {
                'Content-Type': 'application/json',
            },
            // Use a simpler HTTPS agent configuration
            httpsAgent: new https.Agent({
                // For production systems, always enable proper certificate validation
                rejectUnauthorized: true
            }),
            proxy: this.createProxyConfig(this.config.proxy),
        });

        // Log if proxy is being used
        if (config.proxy) {
            console.error(`Using proxy for SFMC API requests: ${config.proxy}`);
        }
    }

    /**
     * Convert proxy string to Axios proxy config
     */
    private createProxyConfig(proxyUrl?: string): AxiosRequestConfig['proxy'] {
        if (!proxyUrl)
            return undefined;
        try {
            const url = new URL(proxyUrl);
            return {
                host: url.hostname,
                port: parseInt(url.port || '80'),
                protocol: url.protocol.replace(':', '')
            };
        }
        catch (error) {
            console.error('Invalid proxy URL format:', error);
            return undefined;
        }
    }

    /**
     * Get an access token for SFMC API
     */
    async getAccessToken(): Promise<string> {
        // Return existing token if it's still valid
        if (this.accessToken && this.tokenExpiration && this.tokenExpiration > new Date()) {
            return this.accessToken;
        }
        try {
            // Use the same structure as the working Node.js example
            const requestBody: Record<string, string> = {
                grant_type: 'client_credentials',
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
            };

            // Add account_id only if it's provided in config
            if (this.config.accountId) {
                requestBody.account_id = this.config.accountId;
            }
            
            // Use the class's axiosInstance with predefined config
            const response = await this.axiosInstance.post(
                `${this.config.authBaseUri}/v2/token`, 
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            this.accessToken = response.data.access_token;
            
            // Set expiration time (usually 20 minutes, subtracting 60 seconds for safety)
            const expiresInSeconds = response.data.expires_in || 1140; // Default to 19 minutes
            this.tokenExpiration = new Date(Date.now() + (expiresInSeconds - 60) * 1000);
            
            if (!this.accessToken) {
                throw new Error('No access token received from SFMC');
            }
            return this.accessToken;
        }
        catch (error: any) {
            // Log error information for debugging
            if (error.response) {
                console.error(`SFMC Auth Error - Status: ${error.response.status}`);
                console.error('Response:', JSON.stringify(error.response.data, null, 2));
            }
            else if (error.request) {
                console.error('No response received from SFMC (possible network issue)');
            }
            else {
                console.error('Error details:', error.message);
            }
            
            // Throw the original error message instead of a generic one
            if (error.response && error.response.data) {
                throw new Error(`SFMC Authentication Error: ${JSON.stringify(error.response.data)}`);
            }
            else if (error.message) {
                throw new Error(`SFMC Authentication Error: ${error.message}`);
            }
            else {
                throw new Error(`SFMC Authentication Error: ${JSON.stringify(error)}`);
            }
        }
    }

    /**
     * Make a request to the SFMC REST API
     */
    async makeRequest<T = any>(
        method: string, 
        endpoint: string, 
        data?: any, 
        parameters?: Record<string, string | number | boolean>
    ): Promise<T> {
        try {
            const accessToken = await this.getAccessToken();
            
            // Make sure the endpoint has the correct format
            const url = endpoint.startsWith('http') ? 
                endpoint : 
                `${this.config.restBaseUri}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
            
            const config: AxiosRequestConfig = {
                method: method.toLowerCase(),
                url,
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                params: parameters
            };
            
            if (data && (method.toLowerCase() === 'post' || method.toLowerCase() === 'put' || method.toLowerCase() === 'patch')) {
                config.data = data;
            }
            
            const response = await this.axiosInstance.request<T>(config);
            return response.data;
        }
        catch (error: any) {
            console.error(`Error making SFMC API request to ${endpoint}:`);
            if (error.response) {
                console.error(`Status: ${error.response.status}`);
                console.error('Response:', JSON.stringify(error.response.data, null, 2));
                throw new Error(`SFMC API error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
            }
            else if (error.request) {
                console.error('No response received (possible network issue)');
                throw new Error(`SFMC API request failed: No response received`);
            }
            else {
                console.error('Error:', error.message);
                throw new Error(`SFMC API request failed: ${error.message}`);
            }
        }
    }

    /**
     * Make a SOAP request to the SFMC SOAP API endpoint
     * @param soapAction The SOAPAction header value (e.g., "Retrieve")
     * @param soapBody The full SOAP XML body as a string
     * @returns The SOAP response XML as a string
     */
    async makeSoapRequest(soapAction: string, soapBody: string): Promise<string> {
        // The SFMC SOAP endpoint is typically: https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/Service.asmx
        // We'll derive it from restBaseUri by replacing 'rest' with 'soap'
        const soapBaseUri = this.config.restBaseUri.replace('rest', 'soap');
        const soapEndpoint = `${soapBaseUri}/Service.asmx`;
        const accessToken = await this.getAccessToken();

        let soapBodyWithToken: string;
        // Match any SOAP header tag, regardless of prefix (e.g., <soapenv:Header>, <SOAP-ENV:Header>, <soap:Header>, etc.)
        const headerRegex = /(<[a-zA-Z0-9\-_:]+Header[^>]*>)(\s*)/i;
        const envelopeRegex = /(<[a-zA-Z0-9\-_:]+Envelope[^>]*>)/i;
        if (headerRegex.test(soapBody)) {
            // Insert <fueloauth> immediately after the opening Header tag
            soapBodyWithToken = soapBody.replace(
                headerRegex,
                `$1<fueloauth>${accessToken}</fueloauth>$2`
            );
        } else {
            // Insert a new header with <fueloauth> as the first child of Envelope
            soapBodyWithToken = soapBody.replace(
                envelopeRegex,
                `$1<soapenv:Header><fueloauth>${accessToken}</fueloauth></soapenv:Header>`
            );
        }

        try {
            const response = await this.axiosInstance.post(
                soapEndpoint,
                soapBodyWithToken,
                {
                    headers: {
                        'Content-Type': 'text/xml',
                        'SOAPAction': soapAction
                        // Do NOT include Authorization header for legacy SOAP
                    }
                }
            );
            return response.data;
        } catch (error: any) {
            let statusMessage = '';
            if (error.response && typeof error.response.data === 'string') {
                // Try to extract <StatusMessage>...</StatusMessage> from the response XML
                const match = error.response.data.match(/<StatusMessage>([\s\S]*?)<\/StatusMessage>/i);
                if (match && match[1]) {
                    statusMessage = `\nStatusMessage: ${match[1].trim()}`;
                }
            }
            if (error.response) {
                throw new Error(`SOAP Error: ${error.response.status} ${error.response.statusText} - ${error.response.data}${statusMessage}`);
            }
            throw error;
        }
    }

    /**
     * Get SFMC data from a REST endpoint (GET request)
     */
    async getData<T = any>(endpoint: string, parameters?: Record<string, string | number | boolean>): Promise<T> {
        return this.makeRequest<T>('get', endpoint, undefined, parameters);
    }

    /**
     * Create SFMC data (POST request)
     */
    async createData<T = any>(endpoint: string, data: any, parameters?: Record<string, string | number | boolean>): Promise<T> {
        return this.makeRequest<T>('post', endpoint, data, parameters);
    }

    /**
     * Update SFMC data (PUT/PATCH request)
     */
    async updateData<T = any>(
        endpoint: string, 
        data: any, 
        parameters?: Record<string, string | number | boolean>, 
        method: 'put' | 'patch' = 'put'
    ): Promise<T> {
        return this.makeRequest<T>(method, endpoint, data, parameters);
    }

    /**
     * Delete SFMC data (DELETE request)
     */
    async deleteData<T = any>(endpoint: string, parameters?: Record<string, string | number | boolean>): Promise<T> {
        return this.makeRequest<T>('delete', endpoint, undefined, parameters);
    }
}

