package main

func shout(s string) string {
	return s + "!"
}

func useGreeter() string {
	return shout(NewGreeter("again").Greet())
}
