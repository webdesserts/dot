#!/usr/bin/env nu

export def exists [command: string] : nothing -> bool {
  not (which $command | is-empty)
}