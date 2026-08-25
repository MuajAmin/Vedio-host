import paramiko

HOST = '43.106.28.115'
PORT = 22
USER = 'root'
PASS = 'Muaj1324@'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, port=PORT, username=USER, password=PASS, timeout=15)

def run(cmd):
    print(f"=== [CMD] {cmd} ===")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out:
        print("[STDOUT]\n" + out.strip())
    if err:
        print("[STDERR]\n" + err.strip())
    print()

run("ls -la /var/www/videohosk/uploads/thumbnails/")
run("sqlite3 /var/www/videohosk/database.sqlite 'SELECT id, title, filename, thumbnail FROM videos;'")
run("node -e \"const http = require('http'); http.get('http://127.0.0.1:3000/thumbnails/sample.jpg', res => console.log('Status:', res.statusCode, res.headers));\"")
run("nginx -T | grep -A 15 'location /internal-thumbnails/'")
run("nginx -T | grep -A 20 'location ~\* \\.(css|js|png|jpg'")

client.close()
