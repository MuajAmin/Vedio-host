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

# Check what Nginx does with the request
run("curl -s -i -k 'https://127.0.0.1/thumbnails/1bad8fc1-0953-49f7-82e3-7cb27f6c57f7.jpg' -H 'Host: muaj.bro.bd' | head -n 25")

client.close()
