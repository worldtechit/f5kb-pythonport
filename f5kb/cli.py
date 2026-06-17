"""f5kb — F5 KB indexing toolkit CLI (click group + global flags)."""

from __future__ import annotations

import sys
import click

from f5kb.version import VERSION
from f5kb.lib.logger import make_logger


@click.group(invoke_without_command=True)
@click.version_option(VERSION, "--version", prog_name="f5kb")
@click.option("--verbose", is_flag=True, help="Debug-level logging.")
@click.option("--debug", is_flag=True, help="Trace-level logging.")
@click.option("--quiet", is_flag=True, help="Warn-level logging only.")
@click.option("--json-logs", is_flag=True, help="Emit logs as NDJSON.")
@click.pass_context
def cli(ctx, verbose, debug, quiet, json_logs):
    """f5kb — F5 Knowledge Base indexing toolkit."""
    ctx.ensure_object(dict)
    level = "trace" if debug else "debug" if verbose else "warn" if quiet else "info"
    ctx.obj["logger"] = make_logger(level=level, json_mode=json_logs, scope="f5kb")
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


def _load_commands():
    from f5kb.cmd.dump import dump_cmd
    from f5kb.cmd.enrich import enrich_cmd
    from f5kb.cmd.track import track_cmd
    from f5kb.cmd.sync import sync_cmd
    from f5kb.cmd.approve import approve_cmd
    from f5kb.cmd.status import status_cmd
    from f5kb.cmd.reconcile import reconcile_cmd
    from f5kb.cmd.fetch import fetch_cmd
    from f5kb.cmd.recent import recent_cmd
    from f5kb.cmd.list_types import list_types_cmd
    from f5kb.cmd.list_products import list_products_cmd
    from f5kb.cmd.discover import discover_cmd
    cli.add_command(dump_cmd, "dump")
    cli.add_command(enrich_cmd, "enrich")
    cli.add_command(track_cmd, "track")
    cli.add_command(sync_cmd, "sync")
    cli.add_command(approve_cmd, "approve")
    cli.add_command(status_cmd, "status")
    cli.add_command(reconcile_cmd, "reconcile")
    cli.add_command(fetch_cmd, "fetch")
    cli.add_command(recent_cmd, "recent")
    cli.add_command(list_types_cmd, "list-types")
    cli.add_command(list_products_cmd, "list-products")
    cli.add_command(discover_cmd, "discover")


_load_commands()
