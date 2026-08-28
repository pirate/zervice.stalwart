#!/usr/bin/env python3
import argparse
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

parser = argparse.ArgumentParser()
parser.add_argument("sender")
parser.add_argument("recipient")
args = parser.parse_args()

message = EmailMessage()
message["From"] = args.sender
message["To"] = args.recipient
message["Subject"] = f"Stalwart migration deliverability check from {args.sender}"
message["Date"] = formatdate(localtime=False, usegmt=True)
message["Message-ID"] = make_msgid(domain=args.sender.rsplit("@", 1)[1])
message.set_content(
    "This is an authorized deliverability test of the Stalwart mail server."
)

with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")), timeout=30) as smtp:
    smtp.ehlo()
    smtp.starttls(context=ssl.create_default_context())
    smtp.ehlo()
    smtp.login(args.sender, os.environ["PASS"])
    smtp.send_message(message)
