package main

import "fmt"

// Greeter says hello.
type Greeter struct {
	name string
}

func NewGreeter(name string) *Greeter {
	return &Greeter{name: name}
}

func (g *Greeter) Greet() string {
	return fmt.Sprintf("hello, %s", g.name)
}

func main() {
	g := NewGreeter("bb")
	fmt.Println(g.Greet())
}
