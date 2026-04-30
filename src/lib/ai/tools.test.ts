
import { describe, it, expect } from 'vitest';
import { validatePath, validateWritePath } from './tools';

describe('Path Validation', () => {
    describe('validatePath', () => {
        it('should allow safe paths', () => {
            expect(validatePath('package/bin/test.py')).toBeNull();
            expect(validatePath('README.md')).toBeNull();
        });

        it('should block absolute system paths', () => {
            expect(validatePath('/etc/passwd')).toContain('Security Error');
            expect(validatePath('/usr/bin/python')).toContain('Security Error');
        });

        it('should block parent directory traversal', () => {
            expect(validatePath('../secret.txt')).toContain('Security Error');
            expect(validatePath('package/../../etc')).toContain('Security Error');
        });

        it('should block hidden directories', () => {
            expect(validatePath('.git/config')).toContain('Security Error');
            expect(validatePath('.env')).toContain('Security Error');
        });
    });

    describe('validateWritePath', () => {
        it('should allow writing to package/ directory', () => {
            expect(validateWritePath('package/bin/test.py')).toBeNull();
            expect(validateWritePath('/package/default/app.conf')).toBeNull();
        });

        it('should block writing outside package/', () => {
            expect(validateWritePath('root_file.txt')).toContain('Security Error');
            expect(validateWritePath('src/components/Test.tsx')).toContain('Security Error');
        });
    });
});
