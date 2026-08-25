module.exports = {
  apps: [
    {
      name: 'videohosk',
      script: 'server.js',
      interpreter: '/usr/local/bin/bun',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
