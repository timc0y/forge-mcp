const chunk = 'x'.repeat(1024);
for (let index = 0; index < 4096; index += 1) process.stdout.write(chunk);
