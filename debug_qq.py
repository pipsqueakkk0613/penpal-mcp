"""Debug QQ mail body structure"""
import imaplib, email, ssl

ctx = ssl.create_default_context()
conn = imaplib.IMAP4_SSL("imap.qq.com", 993, ssl_context=ctx)
conn.login("3815816460@qq.com", "byzxoheyedyqcegh")
conn.select("INBOX")

# Get latest email
status, data = conn.search(None, "ALL")
ids = data[0].split()
latest_id = ids[-1]

status, data = conn.fetch(latest_id, "(RFC822)")
raw = data[0][1]
msg = email.message_from_bytes(raw)

print("Subject:", msg["Subject"])
print("From:", msg["From"])
print("Content-Type:", msg.get_content_type())

# Walk through parts
for i, part in enumerate(msg.walk()):
    ct = part.get_content_type()
    disp = part.get_content_disposition()
    print(f"\nPart {i}: {ct} | disposition: {disp}")
    try:
        payload = part.get_payload(decode=True)
        if payload:
            text = payload.decode('utf-8', errors='replace')
            print(f"  length: {len(text)}")
            print(f"  preview: {text[:200]}")
    except:
        print(f"  (could not decode)")

conn.logout()
