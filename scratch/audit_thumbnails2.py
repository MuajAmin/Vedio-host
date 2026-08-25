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

# Test 1: Node.js directly for actual existing thumbnail
run("node -e \"const http = require('http'); http.get('http://127.0.0.1:3000/thumbnails/1bad8fc1-0953-49f7-82e3-7cb27f6c57f7.jpg', res => console.log('Node directly:', res.statusCode, res.headers));\"")

# Test 2: Nginx directly for actual existing thumbnail
run("curl -s -I http://127.0.0.1/thumbnails/1bad8fc1-0953-49f7-82e3-7cb27f6c57f7.jpg")
run("curl -s -I -k https://127.0.0.1/thumbnails/1bad8fc1-0953-49f7-82e3-7cb27f6c57f7.jpg -H 'Host: muaj.bro.bd'")

# Test 3: What videos are in database and what thumbnails do they reference?
run("node -e \"const db = require('/var/www/videohosk/database'); console.log(db.prepare('SELECT id, title, thumbnail, filename FROM videos').all());\"")

# Test 4: Check if videos have thumbnail files on disk or if thumbnail column is empty
run("ls -lh /var/www/videohosk/uploads/thumbnails/")

client.close()
