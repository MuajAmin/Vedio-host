const { describe, test, expect } = require('bun:test');
const { validateCsrf, handleCsrfError } = require('../utils/security');

describe('Security CSRF Protection & Error Handling', () => {
    test('validateCsrf should allow safe HTTP methods (GET, HEAD, OPTIONS)', () => {
        const req = { method: 'GET', session: {} };
        expect(validateCsrf(req)).toBe(true);
    });

    test('validateCsrf should reject unsafe methods without token', () => {
        const req = { method: 'POST', session: { csrfToken: 'token123' }, body: {} };
        expect(validateCsrf(req)).toBe(false);
    });

    test('validateCsrf should accept matching token in body or headers', () => {
        const reqWithBody = {
            method: 'POST',
            session: { csrfToken: 'secret_token_123' },
            body: { _csrf: 'secret_token_123' },
            get: () => null
        };
        expect(validateCsrf(reqWithBody)).toBe(true);

        const reqWithHeader = {
            method: 'POST',
            session: { csrfToken: 'secret_token_123' },
            body: {},
            get: (header) => (header === 'x-csrf-token' ? 'secret_token_123' : null)
        };
        expect(validateCsrf(reqWithHeader)).toBe(true);
    });

    test('handleCsrfError should send 403 JSON for AJAX / JSON requests', () => {
        let statusCode = null;
        let jsonResponse = null;

        const req = {
            xhr: true,
            headers: { accept: 'application/json' },
            session: { user: 'muaj' }
        };

        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(data) {
                jsonResponse = data;
                return this;
            }
        };

        handleCsrfError(req, res);

        expect(statusCode).toBe(403);
        expect(jsonResponse).toBeDefined();
        expect(jsonResponse.error).toBe('Invalid security token. Please refresh the page and try again.');
    });

    test('handleCsrfError should render 403 forbidden page for HTML form requests', () => {
        let statusCode = null;
        let renderView = null;
        let renderData = null;

        const req = {
            xhr: false,
            headers: { accept: 'text/html' },
            session: { user: 'hajera' }
        };

        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            render(view, data) {
                renderView = view;
                renderData = data;
                return this;
            }
        };

        handleCsrfError(req, res);

        expect(statusCode).toBe(403);
        expect(renderView).toBe('forbidden');
        expect(renderData.user).toBe('hajera');
        expect(renderData.message).toBe('Invalid request token. Please refresh the page and try again.');
    });
});
