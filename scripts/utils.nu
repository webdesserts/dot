#!/usr/bin/env nu

export def exists [command: string] {
  not (which $command | empty?)
}