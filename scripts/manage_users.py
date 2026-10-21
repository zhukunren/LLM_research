"""Trusted, server-only identity administration. Not an HTTP or MCP capability."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apps.api.app import identity


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    link = actions.add_parser("link", help="Link OIDC identity before its first login; legacy user: local-admin")
    link.add_argument("--issuer", required=True)
    link.add_argument("--subject", required=True)
    link.add_argument("--user", required=True)
    permissions = actions.add_parser("permissions")
    permissions.add_argument("--user", required=True)
    permissions.add_argument("--role", choices=("owner", "editor", "viewer"))
    permissions.add_argument("--active", choices=("true", "false"))
    args = parser.parse_args(argv)
    identity.initialize()
    if args.action == "list":
        with identity.connect() as c:
            rows = c.execute("SELECT u.id,u.name,u.active,u.platform_admin,u.permissions_version,u.legacy_workspace,m.tenant_id,m.role FROM users u JOIN tenant_memberships m ON u.id=m.user_id ORDER BY u.created_at,u.id").fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    elif args.action == "link":
        identity.link_external_identity(args.issuer, args.subject, args.user)
        print("OIDC identity linked.")
    else:
        if args.role is None and args.active is None:
            parser.error("permissions requires --role or --active")
        identity.set_permissions(args.user, role=args.role, active=None if args.active is None else args.active == "true")
        print("Permissions updated; existing sessions and delegated task credentials revoked.")


if __name__ == "__main__":
    main()
